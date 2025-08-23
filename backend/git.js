import simpleGit from 'simple-git';
import fs from 'fs/promises';

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
  // Get all branches and filter for common base branches
  const branches = await git.branch(['-a']);
  const baseBranches = [];

  // Check for common base branch names
  const commonBaseBranches = ['main', 'master', 'develop', 'development', 'dev'];

  for (const branchName of commonBaseBranches) {
    // Check local branches
    if (branches.all.includes(branchName)) {
      baseBranches.push(branchName);
    }
    // Check remote branches
    if (branches.all.includes(`origin/${branchName}`)) {
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
    // Get the current branch
    const currentBranch = await getCurrentBranch(repoPath);

    // If we're on the base branch, return empty array
    if (currentBranch === baseBranch || currentBranch === baseBranch.replace('origin/', '')) {
      return [];
    }

    // Get files changed between base branch and current branch
    const diffOutput = await git.diff([`${baseBranch}...HEAD`, '--name-status', '--diff-filter=ACMRTD']);
    return parseDiffOutput(diffOutput);
  } catch (error) {
    // If base branch doesn't exist, try with origin/ prefix or fall back to HEAD~1
    try {
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
}export async function fileStat(absPath) {
  try { return await fs.stat(absPath); } catch { return null; }
}
