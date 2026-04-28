import React, { useEffect, useMemo, useRef, useState } from 'react';
import { getChanged, getStaged, getCommitted, getBranches, getCommits, listTargets, addTarget, updateTarget, deleteTarget, listRemoteDir, testTarget, connectTarget, disconnectTarget, getConnectionStatus, downloadFile, uploadFile, browseDirectory, listRepoFiles, pauseDeployment, resumeDeployment, skipDeploymentFile } from './api';

const LAST_REPO_STORAGE_KEY = 'twindeploy.lastRepoPath';
const RECENT_REPOS_STORAGE_KEY = 'twindeploy.recentRepoPaths';
const IGNORE_RULES_STORAGE_KEY = 'twindeploy.ignoreRules';
const MAX_RECENT_REPOS = 10;
const DEFAULT_IGNORE_RULES = ['.DS_Store'];

// Helper to read SSE from a fetch Response (Safari-friendly)
class EventSourcePoly {
  constructor(response) { this.response = response; this.listeners = {}; this._pump(); }
  on(e, cb) { (this.listeners[e] || (this.listeners[e] = [])).push(cb); }
  close() { this.controller?.abort(); }
  async _pump() {
    const reader = this.response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const lines = chunk.split('\n');
        let ev = 'message', data = '';
        for (const L of lines) {
          if (L.startsWith('event:')) ev = L.slice(6).trim();
          if (L.startsWith('data:')) data += L.slice(5).trim();
        }
        try { data = JSON.parse(data); } catch { }
        (this.listeners[ev] || []).forEach(fn => fn(data));
      }
    }
  }
}

// Format file size
function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function buildManualFileEntry(path, overrides = {}) {
  const normalizedPath = String(path || '').trim().replace(/^\.\/+/, '').replace(/\\/g, '/');
  return {
    path: normalizedPath,
    name: normalizedPath.split('/').pop(),
    status: 'manual',
    action: 'upload',
    source: 'manual',
    ...overrides
  };
}

function parsePastedFileList(input) {
  const entries = [];
  const invalidLines = [];
  const lines = String(input || '').split('\n');

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const renameMatch = line.match(/^R\d*\s+(.+?)\s+(?:->\s+)?(.+)$/);
    if (renameMatch) {
      const oldPath = renameMatch[1].trim();
      const newPath = renameMatch[2].trim();
      if (!oldPath || !newPath) {
        invalidLines.push(rawLine);
        continue;
      }
      entries.push(buildManualFileEntry(newPath, {
        oldPath: oldPath.replace(/^\.\/+/, '').replace(/\\/g, '/'),
        status: 'renamed',
        action: 'rename'
      }));
      continue;
    }

    const statusMatch = line.match(/^([A-Z?]{1,2})\s+(.+)$/);
    if (!statusMatch) {
      entries.push(buildManualFileEntry(line));
      continue;
    }

    const [, statusToken, rawPath] = statusMatch;
    const normalizedStatus = statusToken.replace(/\?/g, '');
    const path = rawPath.trim();
    if (!path) {
      invalidLines.push(rawLine);
      continue;
    }

    const statusMap = {
      A: { status: 'added', action: 'upload' },
      M: { status: 'modified', action: 'upload' },
      D: { status: 'deleted', action: 'delete' },
      T: { status: 'type_changed', action: 'upload' },
      C: { status: 'copied', action: 'upload' },
      U: { status: 'manual', action: 'upload' }
    };

    const resolved = statusMap[normalizedStatus] || statusMap[normalizedStatus.slice(-1)];
    if (!resolved) {
      entries.push(buildManualFileEntry(path));
      continue;
    }

    entries.push(buildManualFileEntry(path, resolved));
  }

  return { entries, invalidLines };
}

function normalizeDeploymentRoot(root) {
  const normalized = String(root || '').trim().replace(/\\/g, '/');
  if (!normalized || normalized === '/') {
    return '/';
  }
  return `/${normalized.replace(/^\/+/, '').replace(/\/+$/, '')}`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globToRegExp(pattern) {
  const source = String(pattern)
    .split('*').map(part => part.split('?').map(escapeRegExp).join('[^/]')).join('.*');
  return new RegExp(`^${source}$`);
}

function parseIgnoreRules(value) {
  return String(value || '')
    .split('\n')
    .map(rule => rule.trim().replace(/\\/g, '/'))
    .filter(rule => rule && !rule.startsWith('#'));
}

function isPathIgnored(path, rules) {
  const normalizedPath = String(path || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
  const basename = normalizedPath.split('/').pop();

  return rules.some(rule => {
    if (rule.endsWith('/')) {
      const dirRule = rule.replace(/\/+$/, '');
      return normalizedPath === dirRule ||
        normalizedPath.startsWith(`${dirRule}/`) ||
        normalizedPath.includes(`/${dirRule}/`);
    }

    const hasPathSeparator = rule.includes('/');
    const target = hasPathSeparator ? normalizedPath : basename;

    if (rule.includes('*') || rule.includes('?')) {
      return globToRegExp(rule).test(target);
    }

    return target === rule;
  });
}

function buildDeploymentTargetKey(targetId, deploymentRoot) {
  return `${targetId}::${normalizeDeploymentRoot(deploymentRoot)}`;
}

function buildQueueEntryKey(targetId, deploymentRoot, fileInfo) {
  const path = fileInfo?.path || fileInfo || '';
  const action = fileInfo?.action || 'upload';
  return `${buildDeploymentTargetKey(targetId, deploymentRoot)}::${action}::${path}`;
}

function appendUnique(items, value) {
  if (!value || items.includes(value)) {
    return items;
  }
  return [...items, value];
}

export default function App() {
  const version = "1.0.0"; // TwinDeploy version
  const [repoPath, setRepoPath] = useState(() => {
    try {
      return localStorage.getItem(LAST_REPO_STORAGE_KEY) || '';
    } catch {
      return '';
    }
  });
  const [recentRepos, setRecentRepos] = useState(() => {
    try {
      const raw = localStorage.getItem(RECENT_REPOS_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
    } catch {
      return [];
    }
  });
  const [mode, setMode] = useState('staged'); // 'changed' | 'staged' | 'committed'
  const [baseRef, setBaseRef] = useState('HEAD~1');
  const [baseBranch, setBaseBranch] = useState(''); // For committed changes mode
  const [committedCompareMode, setCommittedCompareMode] = useState('net'); // 'pr' | 'net' | 'range'
  const [availableBranches, setAvailableBranches] = useState([]);
  const [allBranches, setAllBranches] = useState([]);
  const [currentBranch, setCurrentBranch] = useState('');
  const [commitBranch, setCommitBranch] = useState('');
  const [availableCommits, setAvailableCommits] = useState([]);
  const [fromCommit, setFromCommit] = useState('');
  const [toCommit, setToCommit] = useState('');
  const [commitsLoading, setCommitsLoading] = useState(false);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [diff, setDiff] = useState([]);
  const [manualFiles, setManualFiles] = useState([]);
  const [sel, setSel] = useState({});
  const [targets, setTargets] = useState([]);
  const [targetId, setTargetId] = useState('');
  const [deploymentTargets, setDeploymentTargets] = useState([]);
  const [addDestinationFeedback, setAddDestinationFeedback] = useState(null);
  const [recentlyAddedDestinationKey, setRecentlyAddedDestinationKey] = useState('');
  const [log, setLog] = useState([]);
  const [logCopyFeedback, setLogCopyFeedback] = useState('');
  const [dark, setDark] = useState(true);
  const [showIgnoreDialog, setShowIgnoreDialog] = useState(false);
  const [ignoreRulesText, setIgnoreRulesText] = useState(() => {
    try {
      return localStorage.getItem(IGNORE_RULES_STORAGE_KEY) || DEFAULT_IGNORE_RULES.join('\n');
    } catch {
      return DEFAULT_IGNORE_RULES.join('\n');
    }
  });

  // File view state
  const [fileViewMode, setFileViewMode] = useState('list'); // 'list' | 'tree'
  const [expandedFolders, setExpandedFolders] = useState({});

  // Remote browser state
  const [showRemoteBrowser, setShowRemoteBrowser] = useState(false);
  const [remotePath, setRemotePath] = useState('/');
  const [remoteItems, setRemoteItems] = useState([]);
  const [remoteBusy, setRemoteBusy] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState('disconnected'); // 'connected', 'disconnected', 'connecting', 'disconnecting'
  const [connectionError, setConnectionError] = useState('');
  const connectAbortController = useRef(null);
  const connectionAttemptId = useRef(0);
  const connectionLogTimer = useRef(null);

  // File editor state
  const [editingFile, setEditingFile] = useState(null); // { path, content, originalContent }
  const [showFileEditor, setShowFileEditor] = useState(false);

  // Deployment progress state
  const [deploymentActive, setDeploymentActive] = useState(false);
  const [deploymentPaused, setDeploymentPaused] = useState(false);
  const [activeDeploymentId, setActiveDeploymentId] = useState('');
  const activeDeploymentDestination = useRef(null);
  const removedQueueKeysRef = useRef(new Set());
  const [removedQueueKeys, setRemovedQueueKeys] = useState([]);
  const [deploymentProgress, setDeploymentProgress] = useState({
    total: 0,
    completed: [],
    current: null,
    failed: [],
    skipped: []
  });

  // Folder picker state
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [folderPickerPath, setFolderPickerPath] = useState('');
  const [folderPickerData, setFolderPickerData] = useState(null);
  const [folderPickerLoading, setFolderPickerLoading] = useState(false);
  const [showManualFilePicker, setShowManualFilePicker] = useState(false);
  const [manualPickerMode, setManualPickerMode] = useState('browse');
  const [manualFilePickerPath, setManualFilePickerPath] = useState('');
  const [manualFilePickerData, setManualFilePickerData] = useState(null);
  const [manualFilePickerLoading, setManualFilePickerLoading] = useState(false);
  const [manualFolderPickerLoading, setManualFolderPickerLoading] = useState({});
  const [manualFolderPickerSelection, setManualFolderPickerSelection] = useState({});
  const [manualPickerSelection, setManualPickerSelection] = useState({});
  const [manualPasteValue, setManualPasteValue] = useState('');
  const [queuePanelMode, setQueuePanelMode] = useState('default'); // 'collapsed' | 'default' | 'expanded'
  const [logPanelMode, setLogPanelMode] = useState('default'); // 'collapsed' | 'default' | 'expanded'

  function pickPreferredBaseBranch(branches) {
    if (!branches?.length) return '';
    const preferredOrder = [
      'develop',
      'origin/develop',
      'development',
      'origin/development',
      'dev',
      'origin/dev',
      'main',
      'origin/main',
      'master',
      'origin/master'
    ];

    for (const branch of preferredOrder) {
      if (branches.includes(branch)) return branch;
    }
    return branches[0];
  }

  function formatCommitOption(commit) {
    if (!commit) return '';
    const date = commit.date ? new Date(commit.date).toLocaleDateString() : '';
    const subject = commit.subject || '(no subject)';
    return `${commit.shortHash || commit.hash.slice(0, 7)} ${date ? `• ${date} • ` : '• '}${subject}`;
  }

  function rememberRepoPath(path) {
    const trimmed = (path || '').trim();
    if (!trimmed) return;

    setRecentRepos(prev => {
      const updated = [trimmed, ...prev.filter(p => p !== trimmed)].slice(0, MAX_RECENT_REPOS);
      try {
        localStorage.setItem(LAST_REPO_STORAGE_KEY, trimmed);
        localStorage.setItem(RECENT_REPOS_STORAGE_KEY, JSON.stringify(updated));
      } catch {
        // Ignore storage errors silently.
      }
      return updated;
    });
  }

  function clearRecentRepos() {
    setRecentRepos([]);
    try {
      localStorage.removeItem(RECENT_REPOS_STORAGE_KEY);
    } catch {
      // Ignore storage errors silently.
    }
  }

  useEffect(() => { document.body.classList.toggle('dark', dark); }, [dark]);
  useEffect(() => {
    try {
      localStorage.setItem(IGNORE_RULES_STORAGE_KEY, ignoreRulesText);
    } catch {
      // Ignore storage errors silently.
    }
  }, [ignoreRulesText]);
  useEffect(() => { listTargets().then(setTargets); }, []);
  useEffect(() => {
    if (!repoPath && recentRepos.length > 0) {
      setRepoPath(recentRepos[0]);
    }
  }, [repoPath, recentRepos]);
  useEffect(() => { loadBranches(); }, [repoPath]);
  useEffect(() => {
    if (repoPath && committedCompareMode === 'range') {
      loadCommits(commitBranch || currentBranch || 'HEAD');
    }
  }, [repoPath, commitBranch, committedCompareMode]);
  useEffect(() => {
    setDiff([]);
    setSel({});
    setExpandedFolders({});
    setManualFiles([]);
    setManualPickerSelection({});
    setManualPickerMode('browse');
    setManualFilePickerData(null);
    setManualFilePickerPath('');
    setManualPasteValue('');
    setShowManualFilePicker(false);
    setAvailableCommits([]);
    setFromCommit('');
    setToCommit('');
  }, [repoPath]);

  const ignoreRules = useMemo(() => parseIgnoreRules(ignoreRulesText), [ignoreRulesText]);
  const isIgnoredFilePath = useMemo(
    () => path => isPathIgnored(path, ignoreRules),
    [ignoreRules]
  );
  const allCandidateFiles = useMemo(() => {
    const byPath = new Map();
    diff.forEach(fileInfo => {
      byPath.set(fileInfo.path, fileInfo);
    });
    manualFiles.forEach(fileInfo => {
      if (!byPath.has(fileInfo.path)) {
        byPath.set(fileInfo.path, fileInfo);
      }
    });
    return Array.from(byPath.values());
  }, [diff, manualFiles]);
  const availableFiles = useMemo(
    () => allCandidateFiles.filter(fileInfo => !isIgnoredFilePath(fileInfo.path || fileInfo)),
    [allCandidateFiles, isIgnoredFilePath]
  );
  const ignoredFileCount = allCandidateFiles.length - availableFiles.length;
  const ignoreRuleCount = ignoreRules.length;

  useEffect(() => {
    setSel(prev => {
      let changed = false;
      const next = { ...prev };
      Object.keys(next).forEach(path => {
        if (isIgnoredFilePath(path)) {
          delete next[path];
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [isIgnoredFilePath]);

  const selectedFiles = useMemo(() => {
    const selectedPaths = Object.keys(sel).filter(k => sel[k]);
    const result = [];

    selectedPaths.forEach(path => {
      if (isIgnoredFilePath(path)) {
        return;
      }

      const fileInfo = availableFiles.find(f => f.path === path);
      if (!fileInfo) {
        // Fallback for backward compatibility
        result.push({ path, action: 'upload' });
        return;
      }

      if (fileInfo.status === 'renamed' && fileInfo.oldPath) {
        // For renamed files, show both delete and upload operations
        result.push({
          path: fileInfo.oldPath,
          action: 'delete',
          status: 'deleted',
          isRenameOperation: true,
          renameTo: fileInfo.path
        });
        result.push({
          path: fileInfo.path,
          action: 'upload',
          status: 'added',
          isRenameOperation: true,
          renameFrom: fileInfo.oldPath
        });
      } else {
        result.push(fileInfo);
      }
    });

    return result;
  }, [sel, availableFiles, isIgnoredFilePath]);

  const activeTarget = useMemo(
    () => targets.find(t => t.id === targetId) || null,
    [targets, targetId]
  );

  const activeDeploymentRoot = useMemo(() => {
    if (!activeTarget) {
      return '/';
    }

    if (showRemoteBrowser) {
      return normalizeDeploymentRoot(remotePath || '/');
    }

    return normalizeDeploymentRoot(activeTarget.remoteRoot || '/');
  }, [activeTarget, remotePath, showRemoteBrowser]);

  const resolvedDeploymentTargets = useMemo(() => (
    deploymentTargets
      .map(entry => {
        const target = targets.find(t => t.id === entry.targetId);
        if (!target) return null;
        return {
          ...entry,
          deploymentRoot: normalizeDeploymentRoot(entry.deploymentRoot),
          target
        };
      })
      .filter(Boolean)
  ), [deploymentTargets, targets]);

  const queuedDeploymentEntries = useMemo(() => (
    resolvedDeploymentTargets.flatMap(destination => (
      selectedFiles.map(fileInfo => {
        const path = fileInfo.path || fileInfo;
        const relativePath = destination.deploymentRoot === '/'
          ? `/${path}`
          : `${destination.deploymentRoot.replace(/\/+$/, '')}/${path}`;
        const hostPrefix = destination.target?.host ? `${destination.target.host}:` : '';

        return {
          key: buildQueueEntryKey(destination.targetId, destination.deploymentRoot, fileInfo),
          fileInfo,
          targetId: destination.targetId,
          deploymentRoot: destination.deploymentRoot,
          target: destination.target,
          fullDestPath: `${hostPrefix}${relativePath}`
        };
      })
    ))
  ), [resolvedDeploymentTargets, selectedFiles]);

  const visibleQueuedDeploymentEntries = useMemo(
    () => queuedDeploymentEntries.filter(entry => !removedQueueKeys.includes(entry.key)),
    [queuedDeploymentEntries, removedQueueKeys]
  );

  const queueEntriesByKey = useMemo(() => {
    const mapped = new Map();
    queuedDeploymentEntries.forEach(entry => mapped.set(entry.key, entry));
    return mapped;
  }, [queuedDeploymentEntries]);

  const manualPickerSelectedCount = useMemo(
    () => Object.values(manualPickerSelection).filter(Boolean).length,
    [manualPickerSelection]
  );
  const parsedManualPaste = useMemo(
    () => parsePastedFileList(manualPasteValue),
    [manualPasteValue]
  );

  useEffect(() => {
    setDeploymentTargets(prev => prev.filter(entry => targets.some(t => t.id === entry.targetId)));
  }, [targets]);

  useEffect(() => {
    if (!addDestinationFeedback && !recentlyAddedDestinationKey) {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      setAddDestinationFeedback(null);
      setRecentlyAddedDestinationKey('');
    }, 1800);

    return () => window.clearTimeout(timeoutId);
  }, [addDestinationFeedback, recentlyAddedDestinationKey]);

  useEffect(() => {
    if (!logCopyFeedback) {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => setLogCopyFeedback(''), 1600);
    return () => window.clearTimeout(timeoutId);
  }, [logCopyFeedback]);

  async function copyLogsToClipboard() {
    const text = log.join('\n');
    if (!text) {
      setLogCopyFeedback('No logs to copy');
      return;
    }

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setLogCopyFeedback('Copied');
    } catch (e) {
      setLogCopyFeedback('Copy failed');
    }
  }

  function setFileSelected(path, value) {
    setSel(prev => ({ ...prev, [path]: value }));
    if (deploymentActive && !value) {
      visibleQueuedDeploymentEntries
        .filter(entry => (entry.fileInfo.path || entry.fileInfo) === path)
        .forEach(entry => {
          if (isQueueEntryPending(entry)) {
            removePendingQueueEntry(entry);
          }
        });
    }
  }

  async function openFolderPicker() {
    setShowFolderPicker(true);
    setFolderPickerLoading(true);
    try {
      const data = await browseDirectory('');
      setFolderPickerData(data);
      setFolderPickerPath(data.currentPath);
    } catch (e) {
      alert('Failed to open folder picker: ' + e.message);
    } finally {
      setFolderPickerLoading(false);
    }
  }

  async function navigateToFolder(path) {
    setFolderPickerLoading(true);
    try {
      const data = await browseDirectory(path);
      setFolderPickerData(data);
      setFolderPickerPath(data.currentPath);
    } catch (e) {
      alert('Failed to browse folder: ' + e.message);
    } finally {
      setFolderPickerLoading(false);
    }
  }

  function selectFolder(path) {
    setRepoPath(path);
    rememberRepoPath(path);
    setShowFolderPicker(false);
  }

  async function openManualFilePicker() {
    if (!repoPath) {
      alert('Select a repository first.');
      return;
    }
    setShowManualFilePicker(true);
    setManualPickerMode('browse');
    setManualPickerSelection({});
    setManualFolderPickerSelection({});
    setManualPasteValue('');
    await loadManualFilePicker('');
  }

  async function loadManualFilePicker(dirPath = '') {
    if (!repoPath) return;
    setManualFilePickerLoading(true);
    try {
      const data = await listRepoFiles(repoPath, dirPath);
      if (data.error) {
        throw new Error(data.error);
      }
      setManualFilePickerData(data);
      setManualFilePickerPath(data.currentPath);
    } catch (e) {
      alert('Failed to browse repository files: ' + e.message);
    } finally {
      setManualFilePickerLoading(false);
    }
  }

  function toggleManualPickerFile(path, value) {
    setManualPickerSelection(prev => ({ ...prev, [path]: value }));
  }

  async function toggleManualPickerFolder(path, value) {
    if (!repoPath || manualFolderPickerLoading[path]) return;

    setManualFolderPickerLoading(prev => ({ ...prev, [path]: true }));
    try {
      const data = await listRepoFiles(repoPath, path, { recursive: true });
      if (data.error) {
        throw new Error(data.error);
      }

      setManualPickerSelection(prev => {
        const next = { ...prev };
        (data.files || []).forEach(file => {
          next[file.path] = value;
        });
        return next;
      });
      setManualFolderPickerSelection(prev => {
        const next = { ...prev, [path]: value };
        (data.directories || []).forEach(dir => {
          next[dir.path] = value;
        });
        return next;
      });
    } catch (e) {
      setManualFolderPickerSelection(prev => ({ ...prev, [path]: !value }));
      alert('Failed to select folder files: ' + e.message);
    } finally {
      setManualFolderPickerLoading(prev => {
        const next = { ...prev };
        delete next[path];
        return next;
      });
    }
  }

  function addManualEntriesToList(entries) {
    if (!entries.length) {
      return;
    }

    const dedupedEntries = Array.from(
      new Map(entries.map(entry => [entry.path, entry])).values()
    );
    const existingPaths = new Set(availableFiles.map(fileInfo => fileInfo.path));
    const additions = dedupedEntries.filter(entry => !existingPaths.has(entry.path));

    if (additions.length > 0) {
      setManualFiles(prev => [...prev, ...additions]);
    }

    setSel(prev => {
      const next = { ...prev };
      dedupedEntries.forEach(entry => {
        next[entry.path] = true;
      });
      return next;
    });
  }

  function addManualFilesToList() {
    const selectedEntries = Object.keys(manualPickerSelection)
      .filter(path => manualPickerSelection[path])
      .map(path => buildManualFileEntry(path));
    if (selectedEntries.length === 0) {
      return;
    }

    addManualEntriesToList(selectedEntries);
    setManualPickerSelection({});
    setManualFolderPickerSelection({});
    setShowManualFilePicker(false);
  }

  function addPastedFilesToList() {
    if (parsedManualPaste.entries.length === 0) {
      return;
    }

    addManualEntriesToList(parsedManualPaste.entries);
    setManualPasteValue('');
    setShowManualFilePicker(false);
  }

  function clearManualFiles() {
    const manualPaths = new Set(manualFiles.map(fileInfo => fileInfo.path));
    const gitPaths = new Set(diff.map(fileInfo => fileInfo.path));
    setManualFiles([]);
    setSel(prev => {
      const next = { ...prev };
      manualPaths.forEach(path => {
        if (!gitPaths.has(path)) {
          delete next[path];
        }
      });
      return next;
    });
  }

  async function loadBranches(options = {}) {
    if (!repoPath) return;
    const { refreshCommittedDiff = false } = options;
    setBranchesLoading(true);
    try {
      const res = await getBranches(repoPath);
      const branches = Array.from(new Set(res.baseBranches || []));
      const branchList = Array.from(new Set(res.branches || branches));
      const nextCurrentBranch = res.currentBranch || '';
      const nextBaseBranch = (() => {
        if (branches.length === 0) return '';
        if (baseBranch && branches.includes(baseBranch)) return baseBranch;
        return pickPreferredBaseBranch(branches);
      })();
      const nextCommitBranch = (() => {
        if (commitBranch && branchList.includes(commitBranch)) return commitBranch;
        if (nextCurrentBranch && branchList.includes(nextCurrentBranch)) return nextCurrentBranch;
        return branchList[0] || nextCurrentBranch || 'HEAD';
      })();

      setAvailableBranches(branches);
      setAllBranches(branchList);
      setCurrentBranch(nextCurrentBranch);
      setCommitBranch(nextCommitBranch);
      rememberRepoPath(repoPath);

      // Keep the selected value valid so UI label and API request always match.
      setBaseBranch(nextBaseBranch);

      if (refreshCommittedDiff && mode === 'committed') {
        setDiff([]);
        const committed = committedCompareMode === 'range'
          ? await getCommitted(repoPath, nextBaseBranch, 'range', { fromRef: fromCommit, toRef: toCommit })
          : await getCommitted(repoPath, nextBaseBranch, committedCompareMode);
        setDiff(committed.items || []);
      }
    } catch (e) {
      console.error('Failed to load branches:', e);
    } finally {
      setBranchesLoading(false);
    }
  }

  async function loadCommits(branchRef = commitBranch || currentBranch || 'HEAD') {
    if (!repoPath) return;
    setCommitsLoading(true);
    try {
      const res = await getCommits(repoPath, branchRef, 100);
      const commits = res.commits || [];
      setAvailableCommits(commits);
      setToCommit(prev => (prev && commits.some(commit => commit.hash === prev)) ? prev : (commits[0]?.hash || ''));
      setFromCommit(prev => {
        if (prev && commits.some(commit => commit.hash === prev)) return prev;
        return commits[1]?.hash || commits[0]?.hash || '';
      });
    } catch (e) {
      console.error('Failed to load commits:', e);
      setAvailableCommits([]);
      setFromCommit('');
      setToCommit('');
    } finally {
      setCommitsLoading(false);
    }
  }

  async function reloadCurrentBranch() {
    await loadBranches({ refreshCommittedDiff: diff.length > 0 });
  }

  async function scan() {
    setDiff([]);
    let res;
    if (mode === 'changed') {
      res = await getChanged(repoPath, baseRef);
    } else if (mode === 'committed') {
      if (committedCompareMode === 'range') {
        if (!fromCommit || !toCommit) {
          alert('Select both commits before scanning a commit range.');
          return;
        }
        if (fromCommit === toCommit) {
          alert('Choose two different commits for the range.');
          return;
        }
        res = await getCommitted(repoPath, baseBranch, 'range', { fromRef: fromCommit, toRef: toCommit });
      } else {
        res = await getCommitted(repoPath, baseBranch, committedCompareMode);
      }
    } else {
      res = await getStaged(repoPath);
    }
    if (res.error) {
      alert('Scan failed: ' + res.error);
      return;
    }
    const items = res.items || []; setDiff(items);
    rememberRepoPath(repoPath);
  }

  function toggleAll(v) {
    const next = {};
    availableFiles.forEach(fileInfo => {
      next[fileInfo.path] = v;
    });
    setSel(next);
  }

  // Build tree structure from flat file list
  function buildFileTree(files) {
    const tree = { name: '/', path: '/', children: {}, files: [] };

    files.forEach(fileInfo => {
      const path = fileInfo.path || fileInfo;
      const parts = path.split('/').filter(p => p);
      let current = tree;

      // Navigate/create folder structure
      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        if (!current.children[part]) {
          current.children[part] = {
            name: part,
            path: parts.slice(0, i + 1).join('/'),
            children: {},
            files: []
          };
        }
        current = current.children[part];
      }

      // Add file to final folder
      current.files.push(fileInfo);
    });

    return tree;
  }

  // Toggle folder expansion
  function toggleFolder(folderPath) {
    setExpandedFolders(prev => ({
      ...prev,
      [folderPath]: !prev[folderPath]
    }));
  }

  // Select/deselect all files in a folder recursively
  function toggleFolderSelection(folder, value) {
    const newSel = { ...sel };
    const affectedPaths = [];

    function processFolder(f) {
      // Select all files in this folder
      f.files.forEach(fileInfo => {
        const path = fileInfo.path || fileInfo;
        newSel[path] = value;
        affectedPaths.push(path);
      });

      // Recursively process subfolders
      Object.values(f.children).forEach(processFolder);
    }

    processFolder(folder);
    setSel(newSel);

    if (deploymentActive && !value) {
      const affectedPathSet = new Set(affectedPaths);
      visibleQueuedDeploymentEntries
        .filter(entry => affectedPathSet.has(entry.fileInfo.path || entry.fileInfo))
        .forEach(entry => {
          if (isQueueEntryPending(entry)) {
            removePendingQueueEntry(entry);
          }
        });
    }
  }

  // Check if all files in a folder are selected
  function isFolderSelected(folder) {
    let allSelected = true;
    let hasFiles = false;

    function checkFolder(f) {
      f.files.forEach(fileInfo => {
        hasFiles = true;
        const path = fileInfo.path || fileInfo;
        if (!sel[path]) allSelected = false;
      });
      Object.values(f.children).forEach(checkFolder);
    }

    checkFolder(folder);
    return hasFiles && allSelected;
  }

  // Check if any files in a folder are selected (for indeterminate state)
  function isFolderPartiallySelected(folder) {
    let someSelected = false;
    let allSelected = true;
    let hasFiles = false;

    function checkFolder(f) {
      f.files.forEach(fileInfo => {
        hasFiles = true;
        const path = fileInfo.path || fileInfo;
        if (sel[path]) someSelected = true;
        else allSelected = false;
      });
      Object.values(f.children).forEach(checkFolder);
    }

    checkFolder(folder);
    return hasFiles && someSelected && !allSelected;
  }

  // Target form state (FileZilla style)
  const emptyTarget = { name: '', protocol: 'ftps', host: '', port: '21', user: '', password: '', key: '', remoteRoot: '/', ignoreCertErrors: true };
  const [editing, setEditing] = useState(null); // existing target id or null
  const [tForm, setTForm] = useState(emptyTarget);
  const [tBusy, setTBusy] = useState(false);
  const [tMsg, setTMsg] = useState('');

  function startNewTarget() { setEditing(null); setTForm(emptyTarget); setTMsg(''); }
  function startEditTarget(t) { setEditing(t.id); setTForm({ ...t }); setTMsg(''); }
  function changeT(field, val) {
    if (field === 'protocol') {
      // Set default port based on protocol
      const defaultPort = val === 'sftp' ? '22' : '21';
      setTForm(f => ({ ...f, [field]: val, port: f.port ? f.port : defaultPort }));
    } else {
      setTForm(f => ({ ...f, [field]: val }));
    }
  }
  async function handleTest() { setTBusy(true); setTMsg('Testing...'); const r = await testTarget(tForm); setTMsg(r.ok ? 'Connection OK' : (r.error || 'Failed')); setTBusy(false); }
  async function handleSave() {
    setTBusy(true); setTMsg(editing ? 'Saving...' : 'Creating...');
    // Use default ports if empty and clean up remoteRoot
    const defaultPort = tForm.protocol === 'sftp' ? 22 : 21;
    const payload = {
      ...tForm,
      port: tForm.port ? Number(tForm.port) : defaultPort,
      remoteRoot: tForm.remoteRoot.trim() || '/'
    };
    try {
      if (editing) {
        const updated = await updateTarget(editing, payload);
        setTargets(ts => ts.map(x => x.id === updated.id ? updated : x));
        setTMsg('Updated');
      } else {
        const created = await addTarget(payload);
        setTargets(ts => [created, ...ts]); setTargetId(created.id); setTMsg('Created'); setEditing(created.id);
      }
    } catch (e) { setTMsg('Error'); }
    finally { setTBusy(false); }
  }

  // Connection management
  function stopConnectionProgressLog() {
    if (connectionLogTimer.current) {
      window.clearInterval(connectionLogTimer.current);
      connectionLogTimer.current = null;
    }
  }

  async function handleConnect() {
    if (!targetId) return;
    const target = targets.find(t => t.id === targetId);
    const targetLabel = target?.name || target?.host || 'server';
    const protocolLabel = String(target?.protocol || 'remote').toUpperCase();
    const portLabel = target?.port || (target?.protocol === 'sftp' ? 22 : 21);
    const activeAttemptId = connectionAttemptId.current + 1;
    connectionAttemptId.current = activeAttemptId;
    connectAbortController.current?.abort();
    stopConnectionProgressLog();
    connectAbortController.current = new AbortController();
    setConnectionStatus('connecting');
    setConnectionError('');
    setLog(l => [
      ...l,
      `Connecting to ${targetLabel} (${protocolLabel} ${target?.host || ''}:${portLabel})...`,
      'Opening remote connection. This can take a while if the server is slow or unreachable.'
    ]);
    const startedAt = Date.now();
    connectionLogTimer.current = window.setInterval(() => {
      if (activeAttemptId !== connectionAttemptId.current) return;
      const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
      setLog(l => [...l, `Still connecting to ${targetLabel} after ${elapsedSeconds}s...`]);
    }, 10000);
    try {
      const result = await connectTarget(targetId, { signal: connectAbortController.current.signal });
      if (activeAttemptId !== connectionAttemptId.current) return;
      stopConnectionProgressLog();
      if (result.ok) {
        setConnectionStatus('connected');
        setLog(l => [...l, `Connected to ${targetLabel}`]);
        // After connecting, automatically show remote browser and browse root directory
        setShowRemoteBrowser(true);
        // Force browse even if connectionStatus hasn't updated yet
        browseRemoteDir('/', true);
      } else {
        setConnectionStatus('disconnected');
        setConnectionError(result.error || 'Failed to connect');
        setLog(l => [...l, `Connection error: ${result.error || 'Unknown error'}`]);
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        return;
      }
      if (activeAttemptId !== connectionAttemptId.current) return;
      stopConnectionProgressLog();
      setConnectionStatus('disconnected');
      setConnectionError(error.message || 'Connection failed');
      setLog(l => [...l, `Connection error: ${error.message || 'Unknown error'}`]);
    } finally {
      if (activeAttemptId === connectionAttemptId.current) {
        stopConnectionProgressLog();
        connectAbortController.current = null;
      }
    }
  }

  async function handleCancelConnect() {
    if (!targetId) return;
    const target = targets.find(t => t.id === targetId);
    const targetLabel = target?.name || target?.host || 'server';
    connectionAttemptId.current += 1;
    connectAbortController.current?.abort();
    connectAbortController.current = null;
    stopConnectionProgressLog();
    setConnectionStatus('disconnecting');
    setLog(l => [...l, `Cancelling connection to ${targetLabel}...`]);
    try {
      await disconnectTarget(targetId);
      setLog(l => [...l, `Cancelled connection to ${targetLabel}`]);
    } catch (error) {
      setLog(l => [...l, `Cancel connection error: ${error.message || 'Unknown error'}`]);
    } finally {
      setConnectionStatus('disconnected');
      setRemoteItems([]);
      setShowRemoteBrowser(false);
    }
  }

  async function handleDisconnect() {
    if (!targetId) return;
    connectionAttemptId.current += 1;
    connectAbortController.current?.abort();
    connectAbortController.current = null;
    stopConnectionProgressLog();
    setConnectionStatus('disconnecting');
    try {
      await disconnectTarget(targetId);
      setConnectionStatus('disconnected');
      setRemoteItems([]);
      setShowRemoteBrowser(false);
      setLog(l => [...l, `Disconnected from ${targets.find(t => t.id === targetId)?.host || 'server'}`]);
    } catch (error) {
      setConnectionStatus('disconnected'); // Force to disconnected state even if there was an error
      setShowRemoteBrowser(false);
      setLog(l => [...l, `Disconnect error: ${error.message || 'Unknown error'}`]);
    }
  }

  // Check connection status when target changes
  useEffect(() => {
    if (targetId) {
      getConnectionStatus(targetId)
        .then(result => {
          const isConnected = result.connected;
          setConnectionStatus(isConnected ? 'connected' : 'disconnected');
          if (isConnected) {
            // If already connected, automatically show remote browser and browse
            setShowRemoteBrowser(true);
            browseRemoteDir('/', true);
          } else {
            setShowRemoteBrowser(false);
          }
        })
        .catch(() => {
          setConnectionStatus('disconnected');
          setShowRemoteBrowser(false);
        });
    } else {
      setConnectionStatus('disconnected');
      setShowRemoteBrowser(false);
    }
  }, [targetId]);

  // Remote directory browsing
  async function browseRemoteDir(path = '/', forceConnect = false) {
    console.log('browseRemoteDir called with path:', path, 'targetId:', targetId, 'connectionStatus:', connectionStatus, 'forceConnect:', forceConnect);
    if (!targetId || (!forceConnect && connectionStatus !== 'connected')) {
      console.log('Cannot browse: no target or not connected');
      return;
    }
    setRemoteBusy(true);
    try {
      const result = await listRemoteDir(targetId, path);
      console.log('Remote dir result:', result);
      if (result.items) {
        setRemoteItems(result.items);
        setRemotePath(path);
        console.log('Set remote path to:', path, 'items count:', result.items.length);
      }
    } catch (error) {
      console.error('Remote browsing error:', error);
      setLog(l => [...l, `Remote browsing error: ${error.message || 'Failed to browse'}`]);
    } finally {
      setRemoteBusy(false);
    }
  }

  function handleNavigateRemote(item) {
    if (item.type === 'd') {
      browseRemoteDir(item.path);
    }
  }

  function handleRemoteParentDir() {
    console.log('handleRemoteParentDir called, current remotePath:', remotePath);
    if (remotePath === '/') {
      console.log('Already at root, cannot go up');
      return;
    }
    const pathParts = remotePath.split('/').filter(part => part !== '');
    const parentPath = pathParts.length <= 1 ? '/' : '/' + pathParts.slice(0, -1).join('/');
    console.log('Navigating to parent path:', parentPath);
    browseRemoteDir(parentPath);
  }

  function toggleRemoteBrowser() {
    if (!showRemoteBrowser && targetId) {
      setShowRemoteBrowser(true);
      if (connectionStatus === 'connected') {
        browseRemoteDir('/');
      }
    } else {
      setShowRemoteBrowser(false);
    }
  }

  // File operations
  async function handleDownloadFile(item) {
    if (!targetId || connectionStatus !== 'connected') return;
    try {
      setLog(l => [...l, `Downloading ${item.name}...`]);
      const response = await downloadFile(targetId, item.path);

      if (response.ok) {
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = item.name;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        setLog(l => [...l, `Downloaded ${item.name} successfully`]);
      } else {
        const error = await response.json();
        setLog(l => [...l, `Download failed: ${error.error || 'Unknown error'}`]);
      }
    } catch (error) {
      setLog(l => [...l, `Download error: ${error.message}`]);
    }
  }

  async function handleEditFile(item) {
    if (!targetId || connectionStatus !== 'connected') return;
    try {
      setLog(l => [...l, `Opening ${item.name} for editing...`]);
      const response = await downloadFile(targetId, item.path);

      if (response.ok) {
        const content = await response.text();
        setEditingFile({
          path: item.path,
          name: item.name,
          content: content,
          originalContent: content
        });
        setShowFileEditor(true);
        setLog(l => [...l, `Opened ${item.name} in editor`]);
      } else {
        const error = await response.json();
        setLog(l => [...l, `Failed to open file: ${error.error || 'Unknown error'}`]);
      }
    } catch (error) {
      setLog(l => [...l, `Edit error: ${error.message}`]);
    }
  }

  async function handleSaveFile() {
    if (!editingFile || !targetId) return;
    try {
      setLog(l => [...l, `Saving ${editingFile.name}...`]);
      const result = await uploadFile(targetId, editingFile.path, editingFile.content);

      if (result.ok) {
        setLog(l => [...l, `Saved ${editingFile.name} successfully`]);
        setEditingFile({ ...editingFile, originalContent: editingFile.content });
      } else {
        setLog(l => [...l, `Save failed: ${result.error || 'Unknown error'}`]);
      }
    } catch (error) {
      setLog(l => [...l, `Save error: ${error.message}`]);
    }
  }

  function handleCloseEditor() {
    if (editingFile && editingFile.content !== editingFile.originalContent) {
      if (!confirm('You have unsaved changes. Are you sure you want to close?')) {
        return;
      }
    }
    setEditingFile(null);
    setShowFileEditor(false);
  }
  async function handleDelete(id) { if (!confirm('Delete this target?')) return; await deleteTarget(id); setTargets(ts => ts.filter(t => t.id !== id)); if (targetId === id) setTargetId(''); if (editing === id) { setEditing(null); setTForm(emptyTarget); } }

  function addCurrentDeploymentTarget() {
    if (!activeTarget) {
      alert('Pick a target first');
      return;
    }

    const nextEntry = {
      targetId: activeTarget.id,
      deploymentRoot: activeDeploymentRoot
    };
    const nextEntryKey = buildDeploymentTargetKey(nextEntry.targetId, nextEntry.deploymentRoot);

    setDeploymentTargets(prev => {
      const alreadyExists = prev.some(entry => (
        entry.targetId === nextEntry.targetId &&
        normalizeDeploymentRoot(entry.deploymentRoot) === nextEntry.deploymentRoot
      ));

      if (alreadyExists) {
        setAddDestinationFeedback({
          type: 'warning',
          message: `Already added: ${activeTarget.name || activeTarget.host} → ${nextEntry.deploymentRoot}`
        });
        setRecentlyAddedDestinationKey('');
        setLog(l => [...l, `Destination already added: ${activeTarget.name || activeTarget.host} → ${nextEntry.deploymentRoot}`]);
        return prev;
      }

      setAddDestinationFeedback({
        type: 'success',
        message: `Added: ${activeTarget.name || activeTarget.host} → ${nextEntry.deploymentRoot}`
      });
      setRecentlyAddedDestinationKey(nextEntryKey);
      setLog(l => [...l, `Added destination: ${activeTarget.name || activeTarget.host} → ${nextEntry.deploymentRoot}`]);
      return [...prev, nextEntry];
    });
  }

  function removeDeploymentTarget(targetIdToRemove, deploymentRootToRemove) {
    const target = targets.find(t => t.id === targetIdToRemove);
    const normalizedRoot = normalizeDeploymentRoot(deploymentRootToRemove);
    setDeploymentTargets(prev => prev.filter(entry => !(
      entry.targetId === targetIdToRemove &&
      normalizeDeploymentRoot(entry.deploymentRoot) === normalizedRoot
    )));
    setLog(l => [...l, `Removed destination: ${target?.name || target?.host || 'Target'} → ${normalizedRoot}`]);
  }

  function clearDeploymentTargets() {
    setDeploymentTargets([]);
    setLog(l => [...l, 'Cleared deployment destinations']);
  }

  async function toggleDeploymentPause() {
    if (!activeDeploymentId) return;
    try {
      if (deploymentPaused) {
        await resumeDeployment(activeDeploymentId);
        setDeploymentPaused(false);
        setLog(l => [...l, 'Deployment resumed']);
      } else {
        await pauseDeployment(activeDeploymentId);
        setDeploymentPaused(true);
        setLog(l => [...l, 'Deployment paused after the current operation finishes']);
      }
    } catch (error) {
      setLog(l => [...l, `Deployment pause/resume error: ${error.message || 'Unknown error'}`]);
    }
  }

  function isQueueEntryPending(entry) {
    return deploymentActive &&
      !deploymentProgress.completed.includes(entry.key) &&
      !deploymentProgress.failed.includes(entry.key) &&
      !deploymentProgress.skipped.includes(entry.key) &&
      deploymentProgress.current !== entry.key;
  }

  async function removePendingQueueEntry(entry) {
    if (!isQueueEntryPending(entry)) return;

    removedQueueKeysRef.current.add(entry.key);
    setRemovedQueueKeys(prev => appendUnique(prev, entry.key));
    setDeploymentProgress(prev => ({
      ...prev,
      total: Math.max(0, prev.total - 1),
      skipped: appendUnique(prev.skipped, entry.key)
    }));

    const activeDestination = activeDeploymentDestination.current;
    const isActiveDestination = activeDeploymentId &&
      activeDestination?.targetId === entry.targetId &&
      normalizeDeploymentRoot(activeDestination.deploymentRoot) === normalizeDeploymentRoot(entry.deploymentRoot);

    if (isActiveDestination) {
      try {
        await skipDeploymentFile(activeDeploymentId, entry.fileInfo);
      } catch (error) {
        setLog(l => [...l, `Could not remove pending operation on server: ${error.message || 'Unknown error'}`]);
      }
    }

    setLog(l => [...l, `Removed pending operation: ${entry.fileInfo.path || entry.fileInfo}`]);
  }

  async function deploy() {
    if (!repoPath) return alert('Set repoPath');
    if (selectedFiles.length === 0) return alert('Select at least one file');
    if (resolvedDeploymentTargets.length === 0) return alert('Add at least one destination');

    // Initialize deployment progress tracking
    removedQueueKeysRef.current = new Set();
    setRemovedQueueKeys([]);
    setDeploymentActive(true);
    setDeploymentPaused(false);
    setActiveDeploymentId('');
    setDeploymentProgress({
      total: visibleQueuedDeploymentEntries.length,
      completed: [],
      current: visibleQueuedDeploymentEntries[0]?.key || null,
      failed: [],
      skipped: []
    });

    try {
      for (const destination of resolvedDeploymentTargets) {
        await new Promise((resolve) => {
          const filesForDestination = selectedFiles.filter(fileInfo => {
            const queueKey = buildQueueEntryKey(destination.targetId, destination.deploymentRoot, fileInfo);
            return !removedQueueKeysRef.current.has(queueKey);
          });

          if (filesForDestination.length === 0) {
            resolve();
            return;
          }

          const firstFile = filesForDestination[0];
          const destinationQueueKeys = filesForDestination.map(fileInfo => (
            buildQueueEntryKey(destination.targetId, destination.deploymentRoot, fileInfo)
          ));
          activeDeploymentDestination.current = {
            targetId: destination.targetId,
            deploymentRoot: destination.deploymentRoot
          };
          setDeploymentProgress(prev => ({
            ...prev,
            current: firstFile ? buildQueueEntryKey(destination.targetId, destination.deploymentRoot, firstFile) : null
          }));

          fetch('/api/deploy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              repoPath,
              files: filesForDestination,
              targetId: destination.targetId,
              deploymentRoot: destination.deploymentRoot
            })
          })
            .then((res) => {
              if (!res.ok) {
                res.json()
                  .catch(() => ({ error: 'Deployment request failed' }))
                  .then((payload) => {
                    setLog(l => [...l, `Request failed for ${destination.target.name || destination.target.host}: ${payload.error || 'Deployment request failed'}`]);
                    setDeploymentProgress(prev => ({
                      ...prev,
                      failed: destinationQueueKeys.reduce((acc, key) => appendUnique(acc, key), prev.failed),
                      current: null
                    }));
                    resolve();
                  });
                return;
              }

              const es = new EventSourcePoly(res);

              es.on('start', d => {
                setActiveDeploymentId(d.id);
                setDeploymentPaused(false);
                setLog(l => [...l, `Start: ${d.total} files → ${d.target} (${destination.deploymentRoot})`]);
              });

              es.on('progress', d => {
                const processedFile = filesForDestination[d.index - 1];
                const nextFile = filesForDestination.find((fileInfo, index) => (
                  index > d.index - 1 &&
                  !removedQueueKeysRef.current.has(buildQueueEntryKey(destination.targetId, destination.deploymentRoot, fileInfo))
                ));
                const processedKey = processedFile
                  ? buildQueueEntryKey(destination.targetId, destination.deploymentRoot, processedFile)
                  : null;
                const nextKey = nextFile
                  ? buildQueueEntryKey(destination.targetId, destination.deploymentRoot, nextFile)
                  : null;
                const failedAction = d.action === 'delete_failed';
                const skippedAction = d.action === 'skipped';

                setLog(l => [...l, `${destination.target.name || destination.target.host}: ${d.action || 'uploaded'} ${d.index}/${d.total}: ${d.file}`]);
                setDeploymentProgress(prev => ({
                  ...prev,
                  completed: failedAction || skippedAction ? prev.completed : appendUnique(prev.completed, processedKey),
                  failed: failedAction ? appendUnique(prev.failed, processedKey) : prev.failed,
                  skipped: skippedAction ? appendUnique(prev.skipped, processedKey) : prev.skipped,
                  current: nextKey
                }));
              });

              es.on('error', d => {
                setLog(l => [...l, `Error on ${destination.target.name || destination.target.host}: ${d.error}`]);
                setDeploymentProgress(prev => ({
                  ...prev,
                  failed: appendUnique(prev.failed, prev.current),
                  current: null
                }));
                es.close();
                resolve();
              });

              es.on('done', () => {
                setLog(l => [...l, `Done: ${destination.target.name || destination.target.host} (${destination.deploymentRoot})`]);
                es.close();
                setActiveDeploymentId('');
                setDeploymentPaused(false);
                setDeploymentProgress(prev => ({ ...prev, current: null }));
                resolve();
              });
            })
            .catch((error) => {
              setLog(l => [...l, `Request failed for ${destination.target.name || destination.target.host}: ${error.message}`]);
              setDeploymentProgress(prev => ({
                ...prev,
                failed: destinationQueueKeys.reduce((acc, key) => appendUnique(acc, key), prev.failed),
                current: null
              }));
              resolve();
            });
        });
      }
    } finally {
      setDeploymentActive(false);
      setDeploymentPaused(false);
      setActiveDeploymentId('');
      activeDeploymentDestination.current = null;
      setDeploymentProgress(prev => ({ ...prev, current: null }));
      setTimeout(() => {
        setDeploymentProgress({ total: 0, completed: [], current: null, failed: [], skipped: [] });
      }, 3000);
    }
  }

  function formatProgressEntry(entry) {
    if (!entry) {
      return 'Unknown deployment item';
    }

    const filePath = entry.fileInfo?.path || entry.fileInfo;
    const action = entry.fileInfo?.action === 'delete' ? 'delete' : 'upload';
    return `${entry.target?.name || entry.target?.host || 'Target'} (${entry.deploymentRoot}) • ${action} • ${filePath}`;
  }

  function renderFileDetails(fileInfo, { compactName = false } = {}) {
    const path = fileInfo.path || fileInfo;

    return (
      <div className="file-info">
        {compactName && <span className="file-icon">📄</span>}
        <span className="mono file-path">{compactName ? (fileInfo.name || path.split('/').pop()) : path}</span>
        {fileInfo.status && (
          <span className={`status-badge ${fileInfo.status}`}>
            {fileInfo.status === 'renamed' && fileInfo.oldPath ? `${fileInfo.status} from ${fileInfo.oldPath}` : fileInfo.status}
          </span>
        )}
        {fileInfo.action && (
          <span className={`action-badge ${fileInfo.action}`}>
            {fileInfo.action === 'delete' ? '🗑️' :
              fileInfo.action === 'rename' ? '📝🗑️📤' :
                fileInfo.action === 'upload' ? '📤' : ''}
          </span>
        )}
        {fileInfo.status === 'renamed' && fileInfo.oldPath && (
          <div className="rename-operations">
            <span className="rename-op delete">🗑️ Delete: {fileInfo.oldPath}</span>
            <span className="rename-op upload">📤 Upload: {path}</span>
          </div>
        )}
      </div>
    );
  }

  // Render tree view recursively
  function renderTreeFolder(folder, depth = 0) {
    const hasChildren = Object.keys(folder.children).length > 0 || folder.files.length > 0;
    const isExpanded = expandedFolders[folder.path];
    const isSelected = isFolderSelected(folder);
    const isPartial = isFolderPartiallySelected(folder);
    const indent = depth * 20;

    return (
      <div key={folder.path} className="tree-folder">
        <div className="tree-folder-header" style={{ paddingLeft: `${indent}px` }}>
          {hasChildren && (
            <button
              className="tree-toggle"
              onClick={() => toggleFolder(folder.path)}
            >
              {isExpanded ? '▼' : '▶'}
            </button>
          )}
          {!hasChildren && <span className="tree-toggle-spacer"></span>}
          <label className="tree-folder-label">
            <input
              type="checkbox"
              checked={isSelected}
              ref={el => {
                if (el) el.indeterminate = isPartial;
              }}
              onChange={(e) => toggleFolderSelection(folder, e.target.checked)}
            />
            <span className="folder-icon">📁</span>
            <span className="folder-name">{folder.name}</span>
            <span className="folder-count">
              ({folder.files.length + Object.values(folder.children).reduce((sum, f) =>
                sum + f.files.length + Object.values(f.children).length, 0)})
            </span>
          </label>
        </div>

        {isExpanded && (
          <div className="tree-folder-content">
            {/* Render subfolders */}
            {Object.values(folder.children)
              .sort((a, b) => a.name.localeCompare(b.name))
              .map(child => renderTreeFolder(child, depth + 1))}

            {/* Render files */}
            {folder.files.map(fileInfo => {
              const path = fileInfo.path || fileInfo;
              return (
                <div key={path} className="tree-file" style={{ paddingLeft: `${indent + 40}px` }}>
                  <label className={`file-item ${sel[path] ? 'on' : ''} ${fileInfo.status || ''}`}>
                    <input
                      type="checkbox"
                      checked={!!sel[path]}
                      onChange={e => setFileSelected(path, e.target.checked)}
                    />
                    {renderFileDetails(fileInfo, { compactName: true })}
                  </label>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  const fileTree = useMemo(() => buildFileTree(availableFiles), [availableFiles]);
  return (
    <div className="wrap">
      <header className="app-header">
        <img src="/app_logo.png" alt="TwinDeploy logo" className="app-logo" />
        <h1>TwinDeploy</h1>
        <p>Selective Git file deployment & replay to other targets via FTP</p>
        <div className="header-actions">
          <button className="btn" onClick={() => setDark(d => !d)}>
            {dark ? '☀️ Light' : '🌙 Dark'} mode
          </button>
        </div>
      </header>

      <div className="grid">
        <section className="panel">
          <h3>1) Remote Targets</h3>
          <div className="target-form">
            <div className="row tight wrap">
              <input placeholder="Name" value={tForm.name} onChange={e => changeT('name', e.target.value)} style={{ flex: '1 1 120px' }} />
              <select value={tForm.protocol} onChange={e => changeT('protocol', e.target.value)}>
                <option value="ftps">ftps</option>
                <option value="sftp">sftp</option>
              </select>
              <input placeholder="Host" value={tForm.host} onChange={e => changeT('host', e.target.value)} style={{ flex: '1 1 160px' }} />
              <input placeholder={tForm.protocol === 'sftp' ? 'Port (22)' : 'Port (21)'} value={tForm.port} onChange={e => changeT('port', e.target.value.replace(/[^0-9]/g, ''))} style={{ width: 70 }} />
              <input placeholder="User" value={tForm.user} onChange={e => changeT('user', e.target.value)} style={{ flex: '1 1 120px' }} />
              {tForm.protocol === 'sftp' && <input placeholder="Key path (optional)" value={tForm.key} onChange={e => changeT('key', e.target.value)} style={{ flex: '2 1 200px' }} />}
              <input type="password" placeholder="Password" value={tForm.password} onChange={e => changeT('password', e.target.value)} style={{ flex: '1 1 140px' }} />
              <input placeholder="Remote root (optional)" value={tForm.remoteRoot} onChange={e => changeT('remoteRoot', e.target.value)} style={{ flex: '2 1 200px' }} />
            </div>
            <div className="row tight">
              {tForm.protocol === 'ftps' && (
                <label className="checkbox">
                  <input type="checkbox" checked={!!tForm.ignoreCertErrors} onChange={e => changeT('ignoreCertErrors', e.target.checked)} />
                  <span>Trust all certificates (fixes hostname mismatch errors)</span>
                </label>
              )}
            </div>
            <div className="row tight">
              <button className="btn sm" disabled={tBusy} onClick={handleTest}>Test</button>
              <button className="btn sm primary" disabled={tBusy || !tForm.host} onClick={handleSave}>{editing ? 'Update' : 'Create'}</button>
              <button className="btn sm" disabled={tBusy} onClick={startNewTarget}>New</button>
              {editing && <button className="btn sm" disabled={tBusy} onClick={() => handleDelete(editing)}>Delete</button>}
              <span className="tmsg mono" style={{ marginLeft: 'auto' }}>{tMsg}</span>
            </div>
          </div>
          <div className="list compact">
            {targets.map(t => (
              <div
                key={t.id}
                className={`target-item selectable ${t.id === targetId ? 'active' : ''} ${deploymentTargets.some(entry => entry.targetId === t.id) ? 'queued' : ''}`}
                onClick={() => { setTargetId(t.id); startEditTarget(t); }}
              >
                <strong>{t.name || t.host}</strong> <code>{t.protocol}</code>
                <span className="id">#{t.id.slice(0, 8)}</span>
              </div>
            ))}
            {targets.length === 0 && <div className="empty">No targets yet.</div>}
          </div>
        </section>

        <section className="panel remote-panel">
          <h3>2) Choose Remote Repository root path</h3>
          <div className="row tight">
            <button className="btn" onClick={toggleRemoteBrowser} disabled={!targetId}>{showRemoteBrowser ? 'Hide Browser' : 'Browse Remote'}</button>
            <button
              className={`btn ${addDestinationFeedback?.type === 'success' ? 'success' : addDestinationFeedback?.type === 'warning' ? 'warning' : ''}`}
              onClick={addCurrentDeploymentTarget}
              disabled={!targetId}
            >
              {addDestinationFeedback?.type === 'success' ? 'Added' : addDestinationFeedback?.type === 'warning' ? 'Already Added' : 'Add Destination'}
            </button>
            {targetId && (
              <>
                {connectionStatus === 'disconnected' && (
                  <button className="btn primary" onClick={handleConnect}>Connect</button>
                )}
                {connectionStatus === 'connected' && (
                  <button className="btn danger" onClick={handleDisconnect}>Disconnect</button>
                )}
                {connectionStatus === 'connecting' && (
                  <button className="btn danger" onClick={handleCancelConnect}>Cancel Connect</button>
                )}
                {connectionStatus === 'disconnecting' && (
                  <button className="btn" disabled>Disconnecting...</button>
                )}
                <div className={`connection-status ${connectionStatus}`}>
                  {connectionStatus === 'connected' ? 'Connected' :
                    connectionStatus === 'disconnected' ? 'Disconnected' :
                      connectionStatus === 'connecting' ? 'Connecting...' : 'Disconnecting...'}
                </div>
              </>
            )}
          </div>
          {addDestinationFeedback && (
            <div className={`destination-feedback ${addDestinationFeedback.type}`}>
              {addDestinationFeedback.message}
            </div>
          )}
          <div className="hint">
            Select a target, optionally browse to a folder, then click `Add Destination`. Switch to another target and repeat to build a multi-target deployment batch.
          </div>
          {connectionError && <div className="connection-error">{connectionError}</div>}
          {showRemoteBrowser && (
            <div className="remote-browser">
              <div className="remote-path-bar">
                <button
                  className="btn sm"
                  onClick={handleRemoteParentDir}
                  disabled={remotePath === '/' || remoteBusy || connectionStatus !== 'connected'}
                  title="Go to parent directory"
                >
                  ⬆️ Up
                </button>
                <div className="current-path mono">{remotePath}</div>
                <button
                  className="btn sm"
                  onClick={() => browseRemoteDir(remotePath)}
                  disabled={remoteBusy || connectionStatus !== 'connected'}
                  title="Refresh current directory"
                >
                  🔄 Refresh
                </button>
              </div>
              <div className="remote-items">
                {remoteBusy ? (
                  <div className="loading">Loading...</div>
                ) : connectionStatus !== 'connected' ? (
                  <div className="empty">Connect to server to browse files</div>
                ) : (
                  <>
                    {/* Add parent directory (..) entry if not at root */}
                    {remotePath !== '/' && (
                      <div
                        key=".."
                        className="remote-item folder parent-dir"
                        onClick={handleRemoteParentDir}
                      >
                        <div className="remote-icon">📁</div>
                        <div className="remote-name">..</div>
                        <div className="remote-size"></div>
                      </div>
                    )}

                    {/* Regular directory and file items */}
                    {remoteItems.length === 0 ? (
                      <div className="empty">Empty directory</div>
                    ) : (
                      remoteItems.map(item => (
                        <div
                          key={item.path}
                          className={`remote-item ${item.type === 'd' ? 'folder' : 'file'}`}
                        >
                          <div className="remote-icon">{item.type === 'd' ? '📁' : '📄'}</div>
                          <div className="remote-name" onClick={() => handleNavigateRemote(item)}>{item.name}</div>
                          <div className="remote-size">{item.type !== 'd' ? formatFileSize(item.size) : ''}</div>
                          {item.type !== 'd' && (
                            <div className="remote-actions">
                              <button
                                className="btn sm"
                                onClick={(e) => { e.stopPropagation(); handleDownloadFile(item); }}
                                title="Download file"
                              >
                                ⬇️
                              </button>
                              <button
                                className="btn sm"
                                onClick={(e) => { e.stopPropagation(); handleEditFile(item); }}
                                title="Edit file"
                              >
                                ✏️
                              </button>
                            </div>
                          )}
                        </div>
                      ))
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </section>

        <section className="panel accent">
          <h3>3) Local Repository</h3>
          <div className="row tight">
            <input value={repoPath} onChange={e => setRepoPath(e.target.value)} placeholder="/absolute/path/to/repo" style={{ flex: 1 }} />
            <button className="btn" onClick={openFolderPicker} title="Browse for folder">📁 Browse</button>
          </div>
          {recentRepos.length > 0 && (
            <div className="row tight">
              <select
                value={recentRepos.includes(repoPath) ? repoPath : ''}
                onChange={e => {
                  if (!e.target.value) return;
                  setRepoPath(e.target.value);
                  rememberRepoPath(e.target.value);
                }}
                style={{ flex: 1 }}
                title="Select from recent repositories"
              >
                <option value="">Recent repositories</option>
                {recentRepos.map(path => (
                  <option key={path} value={path}>{path}</option>
                ))}
              </select>
              <button className="btn sm" onClick={clearRecentRepos} title="Clear saved recent repositories">Clear Recent</button>
            </div>
          )}
          <div className="row tight">
            <label className="radio"><input type="radio" checked={mode === 'changed'} onChange={() => setMode('changed')} /> Changed since</label>
            <input value={baseRef} onChange={e => setBaseRef(e.target.value)} style={{ width: 140 }} disabled={mode !== 'changed'} />
            <label className="radio"><input type="radio" checked={mode === 'staged'} onChange={() => setMode('staged')} /> Staged</label>
            <label className="radio"><input type="radio" checked={mode === 'committed'} onChange={() => setMode('committed')} /> Committed vs</label>
            <select value={baseBranch} onChange={e => setBaseBranch(e.target.value)} style={{ width: 140 }} disabled={mode !== 'committed' || committedCompareMode === 'range'}>
              {availableBranches.map(branch => (
                <option key={branch} value={branch}>{branch}</option>
              ))}
              {availableBranches.length === 0 && <option value="">no branches</option>}
            </select>
            <select value={committedCompareMode} onChange={e => setCommittedCompareMode(e.target.value)} style={{ width: 110 }} disabled={mode !== 'committed'} title="Comparison type: PR diff uses merge-base, Net diff compares branch tips">
              <option value="pr">PR diff</option>
              <option value="net">Net diff</option>
              <option value="range">Commit range</option>
            </select>
            <button className="btn" onClick={reloadCurrentBranch} disabled={!repoPath || branchesLoading} title="Refresh the checked-out branch and branch list without reloading the page">
              {branchesLoading ? 'Reloading...' : 'Reload Branch'}
            </button>
            <button className="btn primary" onClick={scan}>Scan</button>
          </div>
          {mode === 'committed' && committedCompareMode === 'range' && (
            <div className="row tight commit-range-row">
              <label className="radio">Branch</label>
              <select value={commitBranch} onChange={e => setCommitBranch(e.target.value)} style={{ width: 160 }} disabled={commitsLoading}>
                {allBranches.map(branch => (
                  <option key={branch} value={branch}>{branch}</option>
                ))}
                {allBranches.length === 0 && <option value={currentBranch || 'HEAD'}>{currentBranch || 'HEAD'}</option>}
              </select>
              <label className="radio">Base</label>
              <select value={fromCommit} onChange={e => setFromCommit(e.target.value)} className="commit-select" disabled={commitsLoading || availableCommits.length === 0}>
                {availableCommits.map(commit => (
                  <option key={commit.hash} value={commit.hash}>{formatCommitOption(commit)}</option>
                ))}
                {availableCommits.length === 0 && <option value="">no commits</option>}
              </select>
              <label className="radio">Tip</label>
              <select value={toCommit} onChange={e => setToCommit(e.target.value)} className="commit-select" disabled={commitsLoading || availableCommits.length === 0}>
                {availableCommits.map(commit => (
                  <option key={commit.hash} value={commit.hash}>{formatCommitOption(commit)}</option>
                ))}
                {availableCommits.length === 0 && <option value="">no commits</option>}
              </select>
              <button className="btn sm" onClick={() => loadCommits(commitBranch || currentBranch || 'HEAD')} disabled={commitsLoading}>
                {commitsLoading ? 'Loading...' : 'Reload Commits'}
              </button>
            </div>
          )}
          <div className="hint">
            {mode === 'committed' && currentBranch ?
              committedCompareMode === 'range'
                ? `On branch: ${currentBranch}. Comparing selected commits on ${commitBranch || currentBranch || 'HEAD'} using base..tip range. Use Reload Branch after checking out a different branch outside the app.`
                : `On branch: ${currentBranch}. Comparing against ${baseBranch} using ${committedCompareMode === 'pr' ? 'PR diff (merge-base)' : 'Net diff (tip-to-tip)'}. Use Reload Branch after checking out a different branch outside the app.` :
              mode === 'staged' ?
                'Staged files ready for commit.' :
                'Changed files since the specified reference.'
            }
          </div>
        </section>

        <section className="panel files-panel">
          <h3>4) Files <span className="badge">{selectedFiles.length}/{availableFiles.length}</span></h3>
          <div className="toolbar">
            <div className="view-toggle">
              <button
                className={`btn sm ${fileViewMode === 'list' ? 'active' : ''}`}
                onClick={() => setFileViewMode('list')}
              >
                📄 List
              </button>
              <button
                className={`btn sm ${fileViewMode === 'tree' ? 'active' : ''}`}
                onClick={() => setFileViewMode('tree')}
              >
                🌲 Tree
              </button>
            </div>
            <div className="selection-actions">
              <button className="btn sm" onClick={() => setShowIgnoreDialog(true)}>
                Ignore Rules ({ignoreRuleCount})
              </button>
              <button className="btn sm" onClick={openManualFilePicker} disabled={!repoPath}>Add Files</button>
              {manualFiles.length > 0 && (
                <button className="btn sm" onClick={clearManualFiles}>
                  Clear Manual ({manualFiles.length})
                </button>
              )}
              <button className="btn sm" onClick={() => toggleAll(true)}>All</button>
              <button className="btn sm" onClick={() => toggleAll(false)}>None</button>
              {fileViewMode === 'tree' && (
                <>
                  <button className="btn sm" onClick={() => setExpandedFolders({})}>Collapse All</button>
                  <button className="btn sm" onClick={() => {
                    const allFolders = {};
                    function collectFolders(folder) {
                      allFolders[folder.path] = true;
                      Object.values(folder.children).forEach(collectFolders);
                    }
                    collectFolders(fileTree);
                    setExpandedFolders(allFolders);
                  }}>Expand All</button>
                </>
              )}
            </div>
          </div>
          {manualFiles.length > 0 && (
            <div className="hint">
              {manualFiles.length} manually added file{manualFiles.length === 1 ? '' : 's'} will stay in the queue until cleared.
            </div>
          )}

          {fileViewMode === 'list' ? (
            <div className="list files">
              {availableFiles.map(it => (
                <label key={it.path} className={`file-item ${sel[it.path] ? 'on' : ''} ${it.status || ''}`}>
                  <input type="checkbox" checked={!!sel[it.path]} onChange={e => setFileSelected(it.path, e.target.checked)} />
                  {renderFileDetails(it)}
                </label>
              ))}
              {availableFiles.length === 0 && <div className="empty">No files yet. Run a scan or add files manually.</div>}
            </div>
          ) : (
            <div className="tree-view">
              {availableFiles.length > 0 ? (
                <div className="tree-container">
                  {Object.values(fileTree.children)
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map(child => renderTreeFolder(child, 0))}
                  {fileTree.files.map(fileInfo => {
                    const path = fileInfo.path || fileInfo;
                    return (
                      <div key={path} className="tree-file root-file">
                        <label className={`file-item ${sel[path] ? 'on' : ''} ${fileInfo.status || ''}`}>
                          <input
                            type="checkbox"
                            checked={!!sel[path]}
                            onChange={e => setFileSelected(path, e.target.checked)}
                          />
                          {renderFileDetails(fileInfo, { compactName: true })}
                        </label>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="empty">No files yet. Run a scan or add files manually.</div>
              )}
            </div>
          )}
        </section>        <section className="panel wide">
          <div className="section-header-row">
            <h3>File Queue & Deployment Progress <span className="badge">{visibleQueuedDeploymentEntries.length}</span></h3>
            <div className="panel-size-controls">
              <button
                className={`btn sm ${queuePanelMode === 'collapsed' ? 'active' : ''}`}
                onClick={() => setQueuePanelMode('collapsed')}
                title="Collapse queue and progress list"
              >
                Collapse
              </button>
              <button
                className={`btn sm ${queuePanelMode === 'default' ? 'active' : ''}`}
                onClick={() => setQueuePanelMode('default')}
                title="Use default limited height"
              >
                Default
              </button>
              <button
                className={`btn sm ${queuePanelMode === 'expanded' ? 'active' : ''}`}
                onClick={() => setQueuePanelMode('expanded')}
                title="Expand to show full list"
              >
                Expand Full
              </button>
            </div>
          </div>

          {/* Deployment Progress Display (only shown during deployment) */}
          {deploymentActive && (
            <div className="deployment-status">
              <div className="deployment-header">
                <h4>{deploymentPaused ? 'Deployment paused' : `Deploying ${deploymentProgress.total} operations...`}</h4>
                <div className="progress-summary">
                  {deploymentProgress.completed.length} completed, {deploymentProgress.failed.length} failed, {deploymentProgress.skipped.length} removed
                </div>
              </div>
            </div>
          )}

          <div className={`queue-resize-panel ${queuePanelMode}`}>
            <div className={`queue-container ${deploymentActive ? 'deployment-active' : ''}`}>
              {/* File Queue */}
              <div className="queue-section">
                <h4>Queue {deploymentActive ? '(Pending)' : ''}</h4>
                {visibleQueuedDeploymentEntries.length > 0 ? (
                  <div className="file-queue">
                    <div className="queue-header">
                      <div>Source Path</div>
                      <div></div>
                      <div>Destination Path</div>
                      <div></div>
                    </div>
                    {visibleQueuedDeploymentEntries.map(entry => {
                      const { fileInfo, target, targetId: queuedTargetId, deploymentRoot, fullDestPath, key } = entry;
                      const path = fileInfo.path || fileInfo;

                      // Determine status for styling
                      const isCompleted = deploymentProgress.completed.includes(key);
                      const isFailed = deploymentProgress.failed.includes(key);
                      const isCurrent = deploymentProgress.current === key;
                      const canRemovePending = isQueueEntryPending(entry);

                      // Show action indicator
                      const actionIcon = fileInfo.action === 'delete' ? '🗑️' : '📤';

                      // Special handling for rename operations
                      let displayText = path;
                      let destinationText = fileInfo.action === 'delete' ? '(will be deleted)' : fullDestPath;

                      if (fileInfo.isRenameOperation) {
                        if (fileInfo.action === 'delete') {
                          displayText = `${path}`;
                          destinationText = `(delete old file for rename to ${fileInfo.renameTo})`;
                        } else if (fileInfo.action === 'upload') {
                          displayText = `${path}`;
                          destinationText = `${fullDestPath} (upload new file from rename of ${fileInfo.renameFrom})`;
                        }
                      }

                      const targetLabel = `${target?.name || target?.host || queuedTargetId} (${deploymentRoot})`;

                      return (
                        <div key={key} className={`queue-item ${isCompleted ? 'completed' : ''} ${isFailed ? 'failed' : ''} ${isCurrent ? 'current' : ''}`}>
                          <div className="source-path mono" title={`${repoPath}/${path}`}>
                            {actionIcon} {displayText}
                            {isCompleted && <span className="status-icon">✅</span>}
                            {isFailed && <span className="status-icon">❌</span>}
                            {isCurrent && <span className="status-icon">⏳</span>}
                          </div>
                          <div className="arrow">→</div>
                          <div className="dest-path mono" title={fullDestPath}>
                            <strong>{targetLabel}</strong> {destinationText ? `• ${destinationText}` : ''}
                          </div>
                          {deploymentActive && (
                            <button
                              className="btn sm"
                              onClick={() => removePendingQueueEntry(entry)}
                              disabled={!canRemovePending}
                              title={canRemovePending ? 'Remove this pending operation from the active deployment' : 'Only pending operations can be removed'}
                            >
                              Remove
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="empty">
                    {selectedFiles.length === 0 ? 'No files selected.' : 'Add at least one deployment destination.'}
                  </div>
                )}
              </div>

              {/* Deployment Progress (only shown during deployment) */}
              {deploymentActive && (
                <div className="progress-section">
                  <h4>Transfer Progress</h4>

                  {/* Completed Files */}
                  {deploymentProgress.completed.length > 0 && (
                    <div className="progress-group completed">
                      <h5>✅ Completed ({deploymentProgress.completed.length})</h5>
                      <div className="progress-list">
                        {deploymentProgress.completed.map(file => (
                          <div key={file} className="progress-item completed">
                            <span className="progress-file mono">{formatProgressEntry(queueEntriesByKey.get(file))}</span>
                            <span className="progress-status">✅</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Current File */}
                  {deploymentProgress.current && (
                    <div className="progress-group current">
                      <h5>⏳ Transferring</h5>
                      <div className="progress-item current">
                        <span className="progress-file mono">{formatProgressEntry(queueEntriesByKey.get(deploymentProgress.current))}</span>
                        <span className="progress-status">⏳</span>
                      </div>
                    </div>
                  )}

                  {/* Failed Files */}
                  {deploymentProgress.failed.length > 0 && (
                    <div className="progress-group failed">
                      <h5>❌ Failed ({deploymentProgress.failed.length})</h5>
                      <div className="progress-list">
                        {deploymentProgress.failed.map(file => (
                          <div key={file} className="progress-item failed">
                            <span className="progress-file mono">{formatProgressEntry(queueEntriesByKey.get(file))}</span>
                            <span className="progress-status">❌</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Deploy Section */}
          <div className="deploy-section">
            <h4>Deploy</h4>

            {resolvedDeploymentTargets.length > 0 ? (
              <div className="deployment-target-list">
                {resolvedDeploymentTargets.map(destination => (
                  <div
                    key={buildDeploymentTargetKey(destination.targetId, destination.deploymentRoot)}
                    className={`deployment-target-chip ${recentlyAddedDestinationKey === buildDeploymentTargetKey(destination.targetId, destination.deploymentRoot) ? 'recently-added' : ''}`}
                  >
                    <span className="deployment-target-chip-label">
                      {destination.target.name || destination.target.host} ({destination.target.protocol.toUpperCase()}) → {destination.deploymentRoot}
                    </span>
                    <button
                      className="btn sm"
                      onClick={() => removeDeploymentTarget(destination.targetId, destination.deploymentRoot)}
                      disabled={deploymentActive}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="hint">No deployment destinations added yet.</div>
            )}

            <div className="row wrap">
              <button
                className="btn"
                onClick={clearDeploymentTargets}
                disabled={resolvedDeploymentTargets.length === 0 || deploymentActive}
              >
                Clear Destinations
              </button>
              <button
                className="btn primary"
                onClick={deploy}
                disabled={resolvedDeploymentTargets.length === 0 || selectedFiles.length === 0 || deploymentActive}
              >
                {deploymentActive
                  ? `Deploying... (${deploymentProgress.completed.length}/${deploymentProgress.total})`
                  : `Deploy ${visibleQueuedDeploymentEntries.length > 0 ? `${visibleQueuedDeploymentEntries.length} operation${visibleQueuedDeploymentEntries.length === 1 ? '' : 's'}` : 'selected'}`
                }
              </button>
              {deploymentActive && (
                <button
                  className="btn"
                  onClick={toggleDeploymentPause}
                  disabled={!activeDeploymentId}
                >
                  {deploymentPaused ? 'Resume Deployment' : 'Pause Deployment'}
                </button>
              )}
            </div>
          </div>
        </section>

        <section className="panel wide">
          <div className="section-header-row">
            <h3>5) Log</h3>
            <div className="panel-size-controls">
              <button
                className={`btn sm ${logPanelMode === 'collapsed' ? 'active' : ''}`}
                onClick={() => setLogPanelMode('collapsed')}
                title="Collapse log"
              >
                Collapse
              </button>
              <button
                className={`btn sm ${logPanelMode === 'default' ? 'active' : ''}`}
                onClick={() => setLogPanelMode('default')}
                title="Use default limited height"
              >
                Default
              </button>
              <button
                className={`btn sm ${logPanelMode === 'expanded' ? 'active' : ''}`}
                onClick={() => setLogPanelMode('expanded')}
                title="Expand to show full log"
              >
                Expand Full
              </button>
            </div>
          </div>
          <div className={`log-resize-panel ${logPanelMode}`}>
            <div className="log">
              {log.map((msg, i) => <div key={i}>{msg}</div>)}
            </div>
          </div>
          <div className="row tight">
            <button className="btn sm" onClick={copyLogsToClipboard} disabled={log.length === 0} title="Copy all logs">
              📋 Copy
            </button>
            <button className="btn sm" onClick={() => setLog([])}>Clear</button>
            {logCopyFeedback && <span className="inline-feedback">{logCopyFeedback}</span>}
          </div>
        </section>

        <footer className="App-footer">
          <p>Version: {version}</p>
          <p>Developed by Shirley Godfrey Kyeyune</p>
        </footer>
      </div>

      {/* File Editor Modal */}
      {showFileEditor && editingFile && (
        <div className="modal-overlay" onClick={handleCloseEditor}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Edit File: {editingFile.name}</h3>
              <button className="btn sm" onClick={handleCloseEditor}>✕</button>
            </div>
            <div className="modal-body">
              <textarea
                value={editingFile.content}
                onChange={(e) => setEditingFile({ ...editingFile, content: e.target.value })}
                className="file-editor"
                spellCheck={false}
              />
            </div>
            <div className="modal-footer">
              <div className="file-path mono">{editingFile.path}</div>
              <div className="modal-actions">
                <button
                  className="btn"
                  onClick={handleCloseEditor}
                >
                  Cancel
                </button>
                <button
                  className="btn primary"
                  onClick={handleSaveFile}
                  disabled={editingFile.content === editingFile.originalContent}
                >
                  Save {editingFile.content !== editingFile.originalContent ? '*' : ''}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Ignore Rules Modal */}
      {showIgnoreDialog && (
        <div className="modal-overlay" onClick={() => setShowIgnoreDialog(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
            <div className="modal-header">
              <h3>Ignore Files</h3>
              <button className="btn sm" onClick={() => setShowIgnoreDialog(false)}>✕</button>
            </div>
            <div className="modal-body">
              <textarea
                className="ignore-rules-input"
                value={ignoreRulesText}
                onChange={e => setIgnoreRulesText(e.target.value)}
                spellCheck={false}
                placeholder={`.DS_Store\n*.log\nnode_modules/`}
              />
              <div className="hint">
                One rule per line. Supports filenames, folder prefixes ending in `/`, and `*` or `?` globs.
              </div>
            </div>
            <div className="modal-footer">
              <div className="hint">
                {ignoreRuleCount} rule{ignoreRuleCount === 1 ? '' : 's'} active, {ignoredFileCount} file{ignoredFileCount === 1 ? '' : 's'} ignored
              </div>
              <div className="modal-actions">
                <button
                  className="btn"
                  onClick={() => setIgnoreRulesText(DEFAULT_IGNORE_RULES.join('\n'))}
                >
                  Reset Defaults
                </button>
                <button className="btn primary" onClick={() => setShowIgnoreDialog(false)}>
                  Done
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Folder Picker Modal */}
      {showFolderPicker && (
        <div className="modal-overlay" onClick={() => setShowFolderPicker(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 600 }}>
            <div className="modal-header">
              <h3>📁 Select Repository Folder</h3>
              <button className="btn sm" onClick={() => setShowFolderPicker(false)}>✕</button>
            </div>
            <div className="modal-body">
              {folderPickerLoading ? (
                <div style={{ padding: 20, textAlign: 'center' }}>Loading...</div>
              ) : folderPickerData ? (
                <>
                  <div className="folder-picker-path">
                    <button
                      className="btn sm"
                      onClick={() => navigateToFolder(folderPickerData.parent)}
                      disabled={!folderPickerData.parent}
                      title="Go to parent folder"
                    >
                      ⬆️ Up
                    </button>
                    <span className="mono" style={{ marginLeft: 10, fontSize: '0.9em' }}>
                      {folderPickerData.currentPath}
                    </span>
                  </div>

                  {/* Volumes section - show when at home directory */}
                  {folderPickerData.volumes && folderPickerData.volumes.length > 0 && (
                    <div className="folder-picker-section">
                      <div className="folder-picker-section-title">💾 Volumes & Drives</div>
                      <div className="folder-picker-list" style={{ marginBottom: 12 }}>
                        {folderPickerData.volumes.map(vol => (
                          <div key={vol.path} className="folder-picker-item volume-item">
                            <button
                              className="btn sm"
                              onClick={() => navigateToFolder(vol.path)}
                              style={{ marginRight: 10 }}
                              title="Open volume"
                            >
                              💾
                            </button>
                            <span className="folder-name" style={{ flex: 1 }}>
                              {vol.name}
                            </span>
                            <button
                              className="btn sm"
                              onClick={() => navigateToFolder(vol.path)}
                              title="Browse volume"
                            >
                              Open
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Folders section */}
                  {folderPickerData.isHome && <div className="folder-picker-section-title">📁 Folders</div>}
                  <div className="folder-picker-list">
                    {folderPickerData.directories.length === 0 ? (
                      <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)' }}>
                        No folders found in this directory
                      </div>
                    ) : (
                      folderPickerData.directories.map(dir => (
                        <div key={dir.path} className="folder-picker-item">
                          <button
                            className="btn sm"
                            onClick={() => navigateToFolder(dir.path)}
                            style={{ marginRight: 10 }}
                            title="Open folder"
                          >
                            📁
                          </button>
                          <span className="folder-name" style={{ flex: 1 }}>
                            {dir.name}
                            {dir.isGitRepo && <span className="git-badge" title="Git repository">🔀 Git</span>}
                          </span>
                          <button
                            className="btn sm primary"
                            onClick={() => selectFolder(dir.path)}
                            disabled={!dir.isGitRepo}
                            title={dir.isGitRepo ? 'Select this repository' : 'Not a Git repository'}
                          >
                            {dir.isGitRepo ? 'Select' : ''}
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                </>
              ) : (
                <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)' }}>
                  Failed to load folders
                </div>
              )}
            </div>
            <div className="modal-footer">
              <div className="hint">
                💡 Only Git repositories can be selected. Navigate through folders to find your repository.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Manual File Picker Modal */}
      {showManualFilePicker && (
        <div className="modal-overlay" onClick={() => setShowManualFilePicker(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 760 }}>
            <div className="modal-header">
              <h3>➕ Add Repository Files</h3>
              <button className="btn sm" onClick={() => setShowManualFilePicker(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="manual-picker-tabs">
                <button
                  className={`btn sm ${manualPickerMode === 'browse' ? 'active' : ''}`}
                  onClick={() => setManualPickerMode('browse')}
                >
                  Browse
                </button>
                <button
                  className={`btn sm ${manualPickerMode === 'paste' ? 'active' : ''}`}
                  onClick={() => setManualPickerMode('paste')}
                >
                  Paste Paths
                </button>
              </div>

              {manualPickerMode === 'browse' ? (
                manualFilePickerLoading ? (
                  <div style={{ padding: 20, textAlign: 'center' }}>Loading...</div>
                ) : manualFilePickerData ? (
                  <>
                    <div className="folder-picker-path">
                      <button
                        className="btn sm"
                        onClick={() => loadManualFilePicker(manualFilePickerData.parent || '')}
                        disabled={manualFilePickerData.parent === null}
                        title="Go to parent folder"
                      >
                        ⬆️ Up
                      </button>
                      <span className="mono" style={{ marginLeft: 10, fontSize: '0.9em' }}>
                        {manualFilePickerPath ? `/${manualFilePickerPath}` : '/'}
                      </span>
                    </div>

                    <div className="repo-picker-list">
                      {manualFilePickerData.directories.map(dir => (
                        <div key={dir.path} className="repo-picker-item folder">
                          <input
                            type="checkbox"
                            checked={!!manualFolderPickerSelection[dir.path]}
                            disabled={!!manualFolderPickerLoading[dir.path]}
                            onChange={e => {
                              const checked = e.target.checked;
                              setManualFolderPickerSelection(prev => ({ ...prev, [dir.path]: checked }));
                              toggleManualPickerFolder(dir.path, checked);
                            }}
                            title="Select all files in this folder and its subfolders"
                          />
                          <button
                            className="btn sm"
                            onClick={() => loadManualFilePicker(dir.path)}
                            title="Open folder"
                          >
                            📁
                          </button>
                          <button
                            className="repo-picker-name-btn"
                            onClick={() => loadManualFilePicker(dir.path)}
                            title={dir.path}
                          >
                            {dir.name}
                          </button>
                          <span className="repo-picker-meta">
                            {manualFolderPickerLoading[dir.path] ? 'Selecting...' : 'Folder'}
                          </span>
                        </div>
                      ))}

                      {manualFilePickerData.files.map(file => {
                        const alreadyQueued = availableFiles.some(fileInfo => fileInfo.path === file.path);
                        return (
                          <label key={file.path} className="repo-picker-item file">
                            <input
                              type="checkbox"
                              checked={!!manualPickerSelection[file.path]}
                              onChange={e => toggleManualPickerFile(file.path, e.target.checked)}
                            />
                            <span className="repo-picker-name mono" title={file.path}>{file.name}</span>
                            <span className="repo-picker-meta">{formatFileSize(file.size || 0)}</span>
                            {alreadyQueued && <span className="status-badge manual">in queue</span>}
                          </label>
                        );
                      })}

                      {manualFilePickerData.directories.length === 0 && manualFilePickerData.files.length === 0 && (
                        <div className="empty">This folder is empty.</div>
                      )}
                    </div>
                  </>
                ) : (
                  <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)' }}>
                    Failed to load repository files
                  </div>
                )
              ) : (
                <div className="manual-paste-panel">
                  <textarea
                    className="manual-paste-input"
                    value={manualPasteValue}
                    onChange={e => setManualPasteValue(e.target.value)}
                    placeholder={`Paste file paths or Git status lines, for example:\nM  wp-content/plugins/cd-custom-dashboard/assets/js/script.js\nA  wp-content/plugins/app-specific-plugin-asp/Classes/Ajax/BouncedEmails/Handler.php`}
                    spellCheck={false}
                  />
                  <div className="manual-paste-summary">
                    <span>{parsedManualPaste.entries.length} parsed file{parsedManualPaste.entries.length === 1 ? '' : 's'}</span>
                    {parsedManualPaste.invalidLines.length > 0 && (
                      <span>{parsedManualPaste.invalidLines.length} invalid line{parsedManualPaste.invalidLines.length === 1 ? '' : 's'} ignored</span>
                    )}
                  </div>
                  <div className="manual-paste-hint">
                    Supports raw paths and Git-style prefixes like `M`, `A`, `D`, `T`, `C`, and `R100`.
                  </div>
                </div>
              )}
            </div>
            <div className="modal-footer">
              <div className="hint">
                {manualPickerMode === 'browse'
                  ? `${manualPickerSelectedCount} file${manualPickerSelectedCount === 1 ? '' : 's'} selected`
                  : `${parsedManualPaste.entries.length} file${parsedManualPaste.entries.length === 1 ? '' : 's'} ready to add`}
              </div>
              <div className="modal-actions">
                <button className="btn" onClick={() => setShowManualFilePicker(false)}>Cancel</button>
                <button
                  className="btn primary"
                  onClick={manualPickerMode === 'browse' ? addManualFilesToList : addPastedFilesToList}
                  disabled={manualPickerMode === 'browse' ? manualPickerSelectedCount === 0 : parsedManualPaste.entries.length === 0}
                >
                  {manualPickerMode === 'browse' ? 'Add Selected' : 'Add Parsed Files'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
