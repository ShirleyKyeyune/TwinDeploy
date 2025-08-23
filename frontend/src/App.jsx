import React, { useEffect, useMemo, useState, useRef } from 'react';
import { getChanged, getStaged, getCommitted, getBranches, listTargets, addTarget, updateTarget, deleteTarget, startDeploy, listRemoteDir, testTarget, connectTarget, disconnectTarget, getConnectionStatus, downloadFile, uploadFile } from './api';

// Helper to read SSE from a fetch Response (Safari-friendly)
class EventSourcePoly {
  constructor(response){ this.response=response; this.listeners={}; this._pump(); }
  on(e,cb){ (this.listeners[e]||(this.listeners[e]=[])).push(cb); }
  close(){ this.controller?.abort(); }
  async _pump(){
    const reader = this.response.body.getReader();
    const decoder = new TextDecoder();
    let buf='';
    while(true){
      const {value,done} = await reader.read(); if(done) break;
      buf += decoder.decode(value,{stream:true});
      let idx;
      while((idx=buf.indexOf('\n\n'))>=0){
        const chunk = buf.slice(0,idx); buf = buf.slice(idx+2);
        const lines = chunk.split('\n');
        let ev='message', data='';
        for(const L of lines){
          if(L.startsWith('event:')) ev = L.slice(6).trim();
          if(L.startsWith('data:')) data += L.slice(5).trim();
        }
        try { data = JSON.parse(data); } catch {}
        (this.listeners[ev]||[]).forEach(fn=>fn(data));
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

export default function App(){
  const version = "1.0.0"; // TwinDeploy version
  const [repoPath,setRepoPath] = useState('');
  const [mode,setMode] = useState('staged'); // 'changed' | 'staged' | 'committed'
  const [baseRef,setBaseRef] = useState('HEAD~1');
  const [baseBranch,setBaseBranch] = useState('main'); // For committed changes mode
  const [availableBranches,setAvailableBranches] = useState([]);
  const [currentBranch,setCurrentBranch] = useState('');
  const [diff,setDiff] = useState([]);
  const [sel,setSel] = useState({});
  const [targets,setTargets] = useState([]);
  const [targetId,setTargetId] = useState('');
  const [log,setLog] = useState([]);
  const [dark,setDark] = useState(false);

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

  useEffect(()=>{ document.body.classList.toggle('dark', dark); },[dark]);
  useEffect(()=>{ listTargets().then(setTargets); },[]);
  useEffect(()=>{ loadBranches(); },[repoPath]);

  const selectedFiles = useMemo(()=> {
    const selectedPaths = Object.keys(sel).filter(k=>sel[k]);
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
  },[sel, diff]);

  async function loadBranches(){
    if(!repoPath) return;
    try {
      const res = await getBranches(repoPath);
      setAvailableBranches(res.baseBranches || []);
      setCurrentBranch(res.currentBranch || '');
      // Set default base branch if none selected
      if(!baseBranch && res.baseBranches.length > 0) {
        setBaseBranch(res.baseBranches[0]);
      }
    } catch (e) {
      console.error('Failed to load branches:', e);
    }
  }

  async function scan(){
    setDiff([]); setSel({});
    let res;
    if (mode === 'changed') {
      res = await getChanged(repoPath, baseRef);
    } else if (mode === 'committed') {
      res = await getCommitted(repoPath, baseBranch);
    } else {
      res = await getStaged(repoPath);
    }
    const items = res.items||[]; setDiff(items);
  }

  function toggleAll(v){ const m={}; diff.forEach(x=>m[x.path]=v); setSel(m); }

  // Target form state (FileZilla style)
  const emptyTarget = { name:'', protocol:'ftps', host:'', port:'21', user:'', password:'', key:'', remoteRoot:'/', ignoreCertErrors: true };
  const [editing,setEditing] = useState(null); // existing target id or null
  const [tForm,setTForm] = useState(emptyTarget);
  const [tBusy,setTBusy] = useState(false);
  const [tMsg,setTMsg] = useState('');

  function startNewTarget(){ setEditing(null); setTForm(emptyTarget); setTMsg(''); }
  function startEditTarget(t){ setEditing(t.id); setTForm({...t}); setTMsg(''); }
  function changeT(field,val){
    if (field === 'protocol') {
      // Set default port based on protocol
      const defaultPort = val === 'sftp' ? '22' : '21';
      setTForm(f=>({...f, [field]:val, port: f.port ? f.port : defaultPort}));
    } else {
      setTForm(f=>({...f,[field]:val}));
    }
  }
  async function handleTest(){ setTBusy(true); setTMsg('Testing...'); const r=await testTarget(tForm); setTMsg(r.ok?'Connection OK': (r.error||'Failed')); setTBusy(false); }
  async function handleSave(){
    setTBusy(true); setTMsg(editing?'Saving...':'Creating...');
    // Use default ports if empty and clean up remoteRoot
    const defaultPort = tForm.protocol === 'sftp' ? 22 : 21;
    const payload = {
      ...tForm,
      port: tForm.port ? Number(tForm.port) : defaultPort,
      remoteRoot: tForm.remoteRoot.trim() || '/'
    };
    try {
      if(editing){
        const updated = await updateTarget(editing,payload);
        setTargets(ts=> ts.map(x=>x.id===updated.id?updated:x));
        setTMsg('Updated');
      } else {
        const created = await addTarget(payload);
        setTargets(ts=> [created,...ts]); setTargetId(created.id); setTMsg('Created'); setEditing(created.id);
      }
    } catch(e){ setTMsg('Error'); }
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
  async function handleDelete(id){ if(!confirm('Delete this target?')) return; await deleteTarget(id); setTargets(ts=>ts.filter(t=>t.id!==id)); if(targetId===id) setTargetId(''); if(editing===id){ setEditing(null); setTForm(emptyTarget); } }

  async function deploy(){
    if(!repoPath) return alert('Set repoPath');
    if(!targetId) return alert('Pick a target');
    if(selectedFiles.length===0) return alert('Select at least one file');

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

    const res = await fetch('/api/deploy',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        repoPath,
        files: selectedFiles,
        targetId,
        deploymentRoot // Pass the current remote path
      })
    });
    const es = new EventSourcePoly(res);
    es.on('start', d=> {
      setLog(l=>[...l, `Start: ${d.total} files → ${d.target} (${deploymentRoot})`]);
    });
    es.on('progress', d=> {
      setLog(l=>[...l, `${d.action || 'Uploaded'} ${d.index}/${d.total}: ${d.file}`]);
      setDeploymentProgress(prev => ({
        ...prev,
        completed: [...prev.completed, d.file],
        current: d.index < d.total ? (selectedFiles[d.index]?.path || selectedFiles[d.index]) : null
      }));
    });
    es.on('error', d=> {
      setLog(l=>[...l, `Error: ${d.error}`]);
      setDeploymentProgress(prev => ({
        ...prev,
        failed: [...prev.failed, prev.current || 'Unknown file']
      }));
      setDeploymentActive(false);
    });
    es.on('done', d=> {
      setLog(l=>[...l, 'Done']);
      es.close();
      setDeploymentActive(false);
      // Clear progress after a short delay to let user see completion
      setTimeout(() => {
        setDeploymentProgress({ total: 0, completed: [], current: null, failed: [] });
      }, 3000);
    });
  }



  return (
    <div className="wrap">
      <header className="app-header">
        <img src="/app_logo.png" alt="TwinDeploy logo" className="app-logo" />
        <h1>TwinDeploy</h1>
        <p>Selective Git file deployment & replay to other targets via FTP</p>
        <div className="header-actions">
          <button className="btn" onClick={()=>setDark(d=>!d)}>
            {dark ? '☀️ Light' : '🌙 Dark'} mode
          </button>
        </div>
      </header>

      <div className="grid">
        <section className="panel">
          <h3>1) Remote Targets</h3>
          <div className="target-form">
            <div className="row tight wrap">
              <input placeholder="Name" value={tForm.name} onChange={e=>changeT('name',e.target.value)} style={{flex:'1 1 120px'}} />
              <select value={tForm.protocol} onChange={e=>changeT('protocol',e.target.value)}>
                <option value="ftps">ftps</option>
                <option value="sftp">sftp</option>
              </select>
              <input placeholder="Host" value={tForm.host} onChange={e=>changeT('host',e.target.value)} style={{flex:'1 1 160px'}} />
              <input placeholder={tForm.protocol === 'sftp' ? 'Port (22)' : 'Port (21)'} value={tForm.port} onChange={e=>changeT('port',e.target.value.replace(/[^0-9]/g,''))} style={{width:70}} />
              <input placeholder="User" value={tForm.user} onChange={e=>changeT('user',e.target.value)} style={{flex:'1 1 120px'}} />
              {tForm.protocol==='sftp' && <input placeholder="Key path (optional)" value={tForm.key} onChange={e=>changeT('key',e.target.value)} style={{flex:'2 1 200px'}} />}
              <input type="password" placeholder="Password" value={tForm.password} onChange={e=>changeT('password',e.target.value)} style={{flex:'1 1 140px'}} />
              <input placeholder="Remote root (optional)" value={tForm.remoteRoot} onChange={e=>changeT('remoteRoot',e.target.value)} style={{flex:'2 1 200px'}} />
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
              <button className="btn sm primary" disabled={tBusy || !tForm.host} onClick={handleSave}>{editing?'Update':'Create'}</button>
              <button className="btn sm" disabled={tBusy} onClick={startNewTarget}>New</button>
              {editing && <button className="btn sm" disabled={tBusy} onClick={()=>handleDelete(editing)}>Delete</button>}
              <span className="tmsg mono" style={{marginLeft:'auto'}}>{tMsg}</span>
            </div>
          </div>
          <div className="list compact">
            {targets.map(t=> (
              <div key={t.id} className={`target-item selectable ${t.id===targetId?'active':''}`} onClick={()=>{ setTargetId(t.id); startEditTarget(t); }}>
                <strong>{t.name||t.host}</strong> <code>{t.protocol}</code>
                <span className="id">#{t.id.slice(0,8)}</span>
              </div>
            ))}
            {targets.length===0 && <div className="empty">No targets yet.</div>}
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
            <input value={repoPath} onChange={e=>setRepoPath(e.target.value)} placeholder="/absolute/path/to/repo" style={{flex:1}} />
          </div>
          <div className="row tight">
            <label className="radio"><input type="radio" checked={mode==='changed'} onChange={()=>setMode('changed')} /> Changed since</label>
            <input value={baseRef} onChange={e=>setBaseRef(e.target.value)} style={{width:140}} disabled={mode!=='changed'} />
            <label className="radio"><input type="radio" checked={mode==='staged'} onChange={()=>setMode('staged')} /> Staged</label>
            <label className="radio"><input type="radio" checked={mode==='committed'} onChange={()=>setMode('committed')} /> Committed vs</label>
            <select value={baseBranch} onChange={e=>setBaseBranch(e.target.value)} style={{width:140}} disabled={mode!=='committed'}>
              {availableBranches.map(branch => (
                <option key={branch} value={branch}>{branch}</option>
              ))}
              {availableBranches.length === 0 && <option value="main">main</option>}
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
            <button className="btn sm" onClick={()=>toggleAll(true)}>All</button>
            <button className="btn sm" onClick={()=>toggleAll(false)}>None</button>
          </div>
          <div className="list files">
            {diff.map(it=> (
              <label key={it.path} className={`file-item ${sel[it.path]?'on':''} ${it.status || ''}`}>
                <input type="checkbox" checked={!!sel[it.path]} onChange={e=>setSel({...sel,[it.path]:e.target.checked})} />
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
            {diff.length===0 && <div className="empty">No results. Scan first.</div>}
          </div>
        </section>

        <section className="panel wide">
          <h3>File Queue & Deployment Progress <span className="badge">{selectedFiles.length}</span></h3>

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
                disabled={!targetId||selectedFiles.length===0}
              >
                Deploy {selectedFiles.length > 0 ? `${selectedFiles.length} file${selectedFiles.length === 1 ? '' : 's'}` : 'selected'}
              </button>
            </div>
          </div>
        </section>

        <section className="panel wide">
          <h3>5) Log</h3>
          <div className="log">
            {log.map((msg,i)=> <div key={i}>{msg}</div>)}
          </div>
          <div className="row tight">
            <button className="btn sm" onClick={()=>setLog([])}>Clear</button>
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

      <footer className="App-footer">
        <p>Version: {version}</p>
        <p>Developed by Shirley Godfrey Kyeyune</p>
      </footer>
    </div>
  );
}
