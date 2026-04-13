import simpleGit from 'simple-git';
import fs from 'fs/promises';

function pickPreferredBaseBranch(branches = []) {
  if (!branches.length) return '';
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

  for (const name of preferredOrder) {
    if (branches.includes(name)) return name;
  }
  return branches[0];
}

export async function getRepoRoot(repoPath) {
  const git = simpleGit(repoPath);
  return await git.revparse(['--show-toplevel']);
}

export async function getCurrentBranch(repoPath) {
  const git = simpleGit(repoPath);
  return await git.revparse(['--abbrev-ref', 'HEAD']);
}

export async function getBaseBranches(repoPath) {
  const git = simpleGit(repoPath);
  // Get all branches and normalize remote names (e.g. remotes/origin/main -> origin/main)
  const branches = await git.branch(['-a']);
  const normalizedBranches = new Set(
    branches.all
      .map(b => b.trim())
      .map(b => b.replace(/^\*\s*/, ''))
      .map(b => b.split(' -> ')[0])
      .map(b => b.replace(/^remotes\//, ''))
  );
  const baseBranches = [];

  // Check for common base branch names
  const commonBaseBranches = ['main', 'master', 'develop', 'development', 'dev'];

  for (const branchName of commonBaseBranches) {
    // Check local branches
    if (normalizedBranches.has(branchName)) {
      baseBranches.push(branchName);
    }
    // Check remote branches
    if (normalizedBranches.has(`origin/${branchName}`)) {
      baseBranches.push(`origin/${branchName}`);
    }
  }

  return [...new Set(baseBranches)]; // Remove duplicates
}

export async function listChanged(repoPath, baseRef = 'HEAD~1') {
  const git = simpleGit(repoPath);
  const root = await getRepoRoot(repoPath);

  // Get all changes including deletions
  const diffOutput = await git.diff([`${baseRef}...HEAD`, '--name-status', '--diff-filter=ACMRTD']);

  return parseDiffOutput(diffOutput);
}

export async function listCommittedChanges(repoPath, baseBranch = 'main') {
  const git = simpleGit(repoPath);
  const root = await getRepoRoot(repoPath);

  try {
    let effectiveBaseBranch = baseBranch;
    if (!effectiveBaseBranch) {
      const baseBranches = await getBaseBranches(repoPath);
      effectiveBaseBranch = pickPreferredBaseBranch(baseBranches) || 'HEAD~1';
    }

    // Get the current branch
    const currentBranch = await getCurrentBranch(repoPath);

    // If we're on the base branch, return empty array
    if (effectiveBaseBranch !== 'HEAD~1' && (currentBranch === effectiveBaseBranch || currentBranch === effectiveBaseBranch.replace('origin/', ''))) {
      return [];
    }

    // Get files changed between base branch and current branch
    const compareRef = effectiveBaseBranch === 'HEAD~1' ? 'HEAD~1...HEAD' : `${effectiveBaseBranch}...HEAD`;
    const diffOutput = await git.diff([compareRef, '--name-status', '--diff-filter=ACMRTD']);
    return parseDiffOutput(diffOutput);
  } catch (error) {
    // If base branch doesn't exist, try with origin/ prefix or fall back to HEAD~1
    try {
      if (!baseBranch) {
        throw new Error('No base branch available');
      }
      const fallbackBase = baseBranch.startsWith('origin/') ? baseBranch.slice(7) : `origin/${baseBranch}`;
      const diffOutput = await git.diff([`${fallbackBase}...HEAD`, '--name-status', '--diff-filter=ACMRTD']);
      return parseDiffOutput(diffOutput);
    } catch (fallbackError) {
      // Final fallback to HEAD~1
      const diffOutput = await git.diff(['HEAD~1...HEAD', '--name-status', '--diff-filter=ACMRTD']);
      return parseDiffOutput(diffOutput);
    }
  }
}

export async function listStaged(repoPath) {
  const git = simpleGit(repoPath);
  const root = await getRepoRoot(repoPath);
  const status = await git.status();

  const result = [];

  // Handle staged files (modified & staged)
  status.staged.forEach(file => {
    result.push({ path: file, status: 'modified', action: 'upload' });
  });

  // Handle new files added
  status.created.forEach(file => {
    result.push({ path: file, status: 'added', action: 'upload' });
  });

  // Handle deleted files
  status.deleted.forEach(file => {
    result.push({ path: file, status: 'deleted', action: 'delete' });
  });

  // Handle renamed files
  status.renamed.forEach(rename => {
    result.push({
      path: rename.to,
      oldPath: rename.from,
      status: 'renamed',
      action: 'rename'
    });
  });

  return result;
}

// Helper function to parse git diff output with status
function parseDiffOutput(diffOutput) {
  if (!diffOutput.trim()) return [];

  const lines = diffOutput.trim().split('\n');
  const result = [];

  for (const line of lines) {
    const [status, ...pathParts] = line.split('\t');
    const statusChar = status.charAt(0);

    if (statusChar === 'R') {
      // Renamed file: R100	old_path	new_path
      const [oldPath, newPath] = pathParts;
      result.push({
        path: newPath,
        oldPath: oldPath,
        status: 'renamed',
        action: 'rename'
      });
    } else if (statusChar === 'D') {
      // Deleted file
      result.push({
        path: pathParts[0],
        status: 'deleted',
        action: 'delete'
      });
    } else if (statusChar === 'A') {
      // Added file
      result.push({
        path: pathParts[0],
        status: 'added',
        action: 'upload'
      });
    } else if (statusChar === 'M') {
      // Modified file
      result.push({
        path: pathParts[0],
        status: 'modified',
        action: 'upload'
      });
    } else if (statusChar === 'C') {
      // Copied file
      const [oldPath, newPath] = pathParts;
      result.push({
        path: newPath,
        oldPath: oldPath,
        status: 'copied',
        action: 'upload'
      });
    } else if (statusChar === 'T') {
      // Type changed
      result.push({
        path: pathParts[0],
        status: 'type_changed',
        action: 'upload'
      });
    }
  }

  return result;
} export async function fileStat(absPath) {
  try { return await fs.stat(absPath); } catch { return null; }
}
