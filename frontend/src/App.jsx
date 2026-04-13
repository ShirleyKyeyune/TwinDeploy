import React, { useEffect, useMemo, useState, useRef } from 'react';
import { getChanged, getStaged, getCommitted, getBranches, listTargets, addTarget, updateTarget, deleteTarget, startDeploy, listRemoteDir, testTarget, connectTarget, disconnectTarget, getConnectionStatus, downloadFile, uploadFile, browseDirectory } from './api';

const LAST_REPO_STORAGE_KEY = 'twindeploy.lastRepoPath';
const RECENT_REPOS_STORAGE_KEY = 'twindeploy.recentRepoPaths';
const MAX_RECENT_REPOS = 10;

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
  const [availableBranches, setAvailableBranches] = useState([]);
  const [currentBranch, setCurrentBranch] = useState('');
  const [diff, setDiff] = useState([]);
  const [sel, setSel] = useState({});
  const [targets, setTargets] = useState([]);
  const [targetId, setTargetId] = useState('');
  const [log, setLog] = useState([]);
  const [dark, setDark] = useState(false);

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

  // File editor state
  const [editingFile, setEditingFile] = useState(null); // { path, content, originalContent }
  const [showFileEditor, setShowFileEditor] = useState(false);

  // Deployment progress state
  const [deploymentActive, setDeploymentActive] = useState(false);
  const [deploymentProgress, setDeploymentProgress] = useState({
    total: 0,
    completed: [],
    current: null,
    failed: []
  });

  // Folder picker state
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [folderPickerPath, setFolderPickerPath] = useState('');
  const [folderPickerData, setFolderPickerData] = useState(null);
  const [folderPickerLoading, setFolderPickerLoading] = useState(false);
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
  useEffect(() => { listTargets().then(setTargets); }, []);
  useEffect(() => {
    if (!repoPath && recentRepos.length > 0) {
      setRepoPath(recentRepos[0]);
    }
  }, [repoPath, recentRepos]);
  useEffect(() => { loadBranches(); }, [repoPath]);

  const selectedFiles = useMemo(() => {
    const selectedPaths = Object.keys(sel).filter(k => sel[k]);
    const result = [];

    selectedPaths.forEach(path => {
      const fileInfo = diff.find(f => f.path === path);
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
  }, [sel, diff]);

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

  async function loadBranches() {
    if (!repoPath) return;
    try {
      const res = await getBranches(repoPath);
      const branches = Array.from(new Set(res.baseBranches || []));
      setAvailableBranches(branches);
      setCurrentBranch(res.currentBranch || '');
      rememberRepoPath(repoPath);

      // Keep the selected value valid so UI label and API request always match.
      setBaseBranch(prev => {
        if (branches.length === 0) return '';
        if (prev && branches.includes(prev)) return prev;
        return pickPreferredBaseBranch(branches);
      });
    } catch (e) {
      console.error('Failed to load branches:', e);
    }
  }

  async function scan() {
    setDiff([]); setSel({});
    let res;
    if (mode === 'changed') {
      res = await getChanged(repoPath, baseRef);
    } else if (mode === 'committed') {
      res = await getCommitted(repoPath, baseBranch);
    } else {
      res = await getStaged(repoPath);
    }
    const items = res.items || []; setDiff(items);
    rememberRepoPath(repoPath);
  }

  function toggleAll(v) { const m = {}; diff.forEach(x => m[x.path] = v); setSel(m); }

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

    function processFolder(f) {
      // Select all files in this folder
      f.files.forEach(fileInfo => {
        const path = fileInfo.path || fileInfo;
        newSel[path] = value;
      });

      // Recursively process subfolders
      Object.values(f.children).forEach(processFolder);
    }

    processFolder(folder);
    setSel(newSel);
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
  async function handleConnect() {
    if (!targetId) return;
    setConnectionStatus('connecting');
    setConnectionError('');
    try {
      const result = await connectTarget(targetId);
      if (result.ok) {
        setConnectionStatus('connected');
        setLog(l => [...l, `Connected to ${targets.find(t => t.id === targetId)?.host || 'server'}`]);
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
      setConnectionStatus('disconnected');
      setConnectionError(error.message || 'Connection failed');
      setLog(l => [...l, `Connection error: ${error.message || 'Unknown error'}`]);
    }
  }

  async function handleDisconnect() {
    if (!targetId) return;
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

  async function deploy() {
    if (!repoPath) return alert('Set repoPath');
    if (!targetId) return alert('Pick a target');
    if (selectedFiles.length === 0) return alert('Select at least one file');

    // Use current remote browser path as deployment destination
    const selectedTarget = targets.find(t => t.id === targetId);
    let deploymentRoot = remotePath || '/';
    if (!showRemoteBrowser && selectedTarget?.remoteRoot && selectedTarget.remoteRoot.trim()) {
      deploymentRoot = selectedTarget.remoteRoot;
    }

    // Initialize deployment progress tracking
    setDeploymentActive(true);
    setDeploymentProgress({
      total: selectedFiles.length,
      completed: [],
      current: null,
      failed: []
    });

    const res = await fetch('/api/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoPath,
        files: selectedFiles,
        targetId,
        deploymentRoot // Pass the current remote path
      })
    });
    const es = new EventSourcePoly(res);
    es.on('start', d => {
      setLog(l => [...l, `Start: ${d.total} files → ${d.target} (${deploymentRoot})`]);
    });
    es.on('progress', d => {
      setLog(l => [...l, `${d.action || 'Uploaded'} ${d.index}/${d.total}: ${d.file}`]);
      setDeploymentProgress(prev => ({
        ...prev,
        completed: [...prev.completed, d.file],
        current: d.index < d.total ? (selectedFiles[d.index]?.path || selectedFiles[d.index]) : null
      }));
    });
    es.on('error', d => {
      setLog(l => [...l, `Error: ${d.error}`]);
      setDeploymentProgress(prev => ({
        ...prev,
        failed: [...prev.failed, prev.current || 'Unknown file']
      }));
      setDeploymentActive(false);
    });
    es.on('done', d => {
      setLog(l => [...l, 'Done']);
      es.close();
      setDeploymentActive(false);
      // Clear progress after a short delay to let user see completion
      setTimeout(() => {
        setDeploymentProgress({ total: 0, completed: [], current: null, failed: [] });
      }, 3000);
    });
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
                      onChange={e => setSel({ ...sel, [path]: e.target.checked })}
                    />
                    <span className="file-info">
                      <span className="file-icon">📄</span>
                      <span className="mono file-path">{fileInfo.name || path.split('/').pop()}</span>
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
                    </span>
                  </label>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  const fileTree = useMemo(() => buildFileTree(diff), [diff]);
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
              <div key={t.id} className={`target-item selectable ${t.id === targetId ? 'active' : ''}`} onClick={() => { setTargetId(t.id); startEditTarget(t); }}>
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
            {targetId && (
              <>
                {connectionStatus === 'disconnected' && (
                  <button className="btn primary" onClick={handleConnect}>Connect</button>
                )}
                {connectionStatus === 'connected' && (
                  <button className="btn danger" onClick={handleDisconnect}>Disconnect</button>
                )}
                {['connecting', 'disconnecting'].includes(connectionStatus) && (
                  <button className="btn" disabled>{connectionStatus === 'connecting' ? 'Connecting...' : 'Disconnecting...'}</button>
                )}
                <div className={`connection-status ${connectionStatus}`}>
                  {connectionStatus === 'connected' ? 'Connected' :
                    connectionStatus === 'disconnected' ? 'Disconnected' :
                      connectionStatus === 'connecting' ? 'Connecting...' : 'Disconnecting...'}
                </div>
              </>
            )}
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
            <select value={baseBranch} onChange={e => setBaseBranch(e.target.value)} style={{ width: 140 }} disabled={mode !== 'committed'}>
              {availableBranches.map(branch => (
                <option key={branch} value={branch}>{branch}</option>
              ))}
              {availableBranches.length === 0 && <option value="">no branches</option>}
            </select>
            <button className="btn primary" onClick={scan}>Scan</button>
          </div>
          <div className="hint">
            {mode === 'committed' && currentBranch ?
              `On branch: ${currentBranch}. Comparing committed changes against ${baseBranch}.` :
              mode === 'staged' ?
                'Staged files ready for commit.' :
                'Changed files since the specified reference.'
            }
          </div>
        </section>

        <section className="panel files-panel">
          <h3>4) Files <span className="badge">{selectedFiles.length}/{diff.length}</span></h3>
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

          {fileViewMode === 'list' ? (
            <div className="list files">
              {diff.map(it => (
                <label key={it.path} className={`file-item ${sel[it.path] ? 'on' : ''} ${it.status || ''}`}>
                  <input type="checkbox" checked={!!sel[it.path]} onChange={e => setSel({ ...sel, [it.path]: e.target.checked })} />
                  <span className="file-info">
                    <span className="mono file-path">{it.path}</span>
                    {it.status && (
                      <span className={`status-badge ${it.status}`}>
                        {it.status === 'renamed' && it.oldPath ? `${it.status} from ${it.oldPath}` : it.status}
                      </span>
                    )}
                    {it.action && (
                      <span className={`action-badge ${it.action}`}>
                        {it.action === 'delete' ? '🗑️' :
                          it.action === 'rename' ? '📝🗑️📤' :
                            it.action === 'upload' ? '📤' : ''}
                      </span>
                    )}
                    {it.status === 'renamed' && it.oldPath && (
                      <div className="rename-operations">
                        <span className="rename-op delete">🗑️ Delete: {it.oldPath}</span>
                        <span className="rename-op upload">📤 Upload: {it.path}</span>
                      </div>
                    )}
                  </span>
                </label>
              ))}
              {diff.length === 0 && <div className="empty">No results. Scan first.</div>}
            </div>
          ) : (
            <div className="tree-view">
              {diff.length > 0 ? (
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
                            onChange={e => setSel({ ...sel, [path]: e.target.checked })}
                          />
                          <span className="file-info">
                            <span className="file-icon">📄</span>
                            <span className="mono file-path">{fileInfo.name || path}</span>
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
                          </span>
                        </label>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="empty">No results. Scan first.</div>
              )}
            </div>
          )}
        </section>        <section className="panel wide">
          <div className="section-header-row">
            <h3>File Queue & Deployment Progress <span className="badge">{selectedFiles.length}</span></h3>
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
                <h4>Deploying {deploymentProgress.total} files...</h4>
                <div className="progress-summary">
                  {deploymentProgress.completed.length} completed, {deploymentProgress.failed.length} failed
                </div>
              </div>
            </div>
          )}

          <div className={`queue-resize-panel ${queuePanelMode}`}>
            <div className={`queue-container ${deploymentActive ? 'deployment-active' : ''}`}>
              {/* File Queue */}
              <div className="queue-section">
                <h4>Queue {deploymentActive ? '(Pending)' : ''}</h4>
                {selectedFiles.length > 0 && targetId ? (
                  <div className="file-queue">
                    <div className="queue-header">
                      <div>Source Path</div>
                      <div></div>
                      <div>Destination Path</div>
                    </div>
                    {selectedFiles.map(fileInfo => {
                      const path = fileInfo.path || fileInfo; // backward compatibility
                      const selectedTarget = targets.find(t => t.id === targetId);
                      let destinationRoot = remotePath || '/';
                      if (!showRemoteBrowser && selectedTarget?.remoteRoot && selectedTarget.remoteRoot.trim()) {
                        destinationRoot = selectedTarget.remoteRoot;
                      }
                      const relativePath = destinationRoot === '/' ?
                        `/${path}` :
                        `${destinationRoot.replace(/\/+$/, '')}/${path}`;
                      const hostPrefix = selectedTarget ? `${selectedTarget.host}:` : '';
                      const fullDestPath = `${hostPrefix}${relativePath}`;

                      // Determine status for styling
                      const isCompleted = deploymentProgress.completed.includes(path);
                      const isFailed = deploymentProgress.failed.includes(path);
                      const isCurrent = deploymentProgress.current === path;

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

                      return (
                        <div key={`${path}-${fileInfo.action}`} className={`queue-item ${isCompleted ? 'completed' : ''} ${isFailed ? 'failed' : ''} ${isCurrent ? 'current' : ''}`}>
                          <div className="source-path mono" title={`${repoPath}/${path}`}>
                            {actionIcon} {displayText}
                            {isCompleted && <span className="status-icon">✅</span>}
                            {isFailed && <span className="status-icon">❌</span>}
                            {isCurrent && <span className="status-icon">⏳</span>}
                          </div>
                          <div className="arrow">→</div>
                          <div className="dest-path mono" title={fullDestPath}>
                            {destinationText}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="empty">
                    {selectedFiles.length === 0 ? 'No files selected.' : 'Select a target to see destination paths.'}
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
                            <span className="progress-file mono">{file}</span>
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
                        <span className="progress-file mono">{deploymentProgress.current}</span>
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
                            <span className="progress-file mono">{file}</span>
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

            {/* Display current deployment target */}
            {targetId && (
              <div className="deployment-target-info">
                <div className="target-display">
                  <strong>Target:</strong> {(() => {
                    const selectedTarget = targets.find(t => t.id === targetId);
                    if (!selectedTarget) return 'No target selected';

                    let deploymentRoot = remotePath || '/';
                    if (!showRemoteBrowser && selectedTarget?.remoteRoot && selectedTarget.remoteRoot.trim()) {
                      deploymentRoot = selectedTarget.remoteRoot;
                    }

                    return `${selectedTarget.name || selectedTarget.host} (${selectedTarget.protocol.toUpperCase()}) → ${deploymentRoot}`;
                  })()}
                </div>
              </div>
            )}

            <div className="row wrap">
              <button
                className="btn primary"
                onClick={deploy}
                disabled={!targetId || selectedFiles.length === 0 || deploymentActive}
              >
                {deploymentActive
                  ? `Deploying... (${deploymentProgress.completed.length}/${deploymentProgress.total})`
                  : `Deploy ${selectedFiles.length > 0 ? `${selectedFiles.length} file${selectedFiles.length === 1 ? '' : 's'}` : 'selected'}`
                }
              </button>
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
            <button className="btn sm" onClick={() => setLog([])}>Clear</button>
          </div>
        </section>
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

      <footer className="App-footer">
        <p>Version: {version}</p>
        <p>Developed by Shirley Godfrey Kyeyune</p>
      </footer>
    </div>
  );
}
