export async function getChanged(repoPath, baseRef) {
  const r = await fetch(`/api/repo/changed?repoPath=${encodeURIComponent(repoPath)}&baseRef=${encodeURIComponent(baseRef || 'HEAD~1')}`);
  return r.json();
}
export async function getStaged(repoPath) {
  const r = await fetch(`/api/repo/staged?repoPath=${encodeURIComponent(repoPath)}`);
  return r.json();
}
export async function getCommitted(repoPath, baseBranch, compareMode = 'net') {
  const r = await fetch(`/api/repo/committed?repoPath=${encodeURIComponent(repoPath)}&baseBranch=${encodeURIComponent(baseBranch || '')}&compareMode=${encodeURIComponent(compareMode)}`);
  return r.json();
}
export async function getBranches(repoPath) {
  const r = await fetch(`/api/repo/branches?repoPath=${encodeURIComponent(repoPath)}`);
  return r.json();
}
export async function listRepoFiles(repoPath, dirPath = '', options = {}) {
  const params = new URLSearchParams({
    repoPath,
    dirPath
  });
  if (options.recursive) {
    params.set('recursive', 'true');
  }
  const r = await fetch(`/api/repo/files?${params.toString()}`);
  return r.json();
}
export async function browseDirectory(dirPath) {
  const r = await fetch(`/api/browse?dirPath=${encodeURIComponent(dirPath || '')}`);
  return r.json();
}
export async function listTargets() { const r = await fetch('/api/targets'); return r.json(); }
export async function addTarget(t) { const r = await fetch('/api/targets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(t) }); return r.json(); }
export async function updateTarget(id, t) { const r = await fetch('/api/targets/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(t) }); return r.json(); }
export async function deleteTarget(id) { const r = await fetch('/api/targets/' + id, { method: 'DELETE' }); return r.json(); }
export async function startDeploy(payload) {
  const res = await fetch('/api/deploy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  return new EventSourcePoly(res);
}
export async function startReplay(payload) {
  const res = await fetch('/api/replay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  return new EventSourcePoly(res);
}
export async function listManifests() { const r = await fetch('/api/manifests'); return r.json(); }
export async function testTarget(t) { const r = await fetch('/api/targets/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(t) }); return r.json(); }
export async function listRemoteDir(targetId, path) { const r = await fetch(`/api/targets/${targetId}/browse?path=${encodeURIComponent(path || '/')}`); return r.json(); }
export async function connectTarget(targetId, options = {}) { const r = await fetch(`/api/targets/${targetId}/connect`, { method: 'POST', signal: options.signal }); return r.json(); }
export async function disconnectTarget(targetId) { const r = await fetch(`/api/targets/${targetId}/disconnect`, { method: 'POST' }); return r.json(); }
export async function getConnectionStatus(targetId) { const r = await fetch(`/api/targets/${targetId}/status`); return r.json(); }
export async function downloadFile(targetId, filePath) { const r = await fetch(`/api/targets/${targetId}/download?path=${encodeURIComponent(filePath)}`); return r; }
export async function uploadFile(targetId, filePath, fileContent) { const r = await fetch(`/api/targets/${targetId}/upload`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: filePath, content: fileContent }) }); return r.json(); }

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
