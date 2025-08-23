import express from 'express';
import cors from 'cors';
import { v4 as uuid } from 'uuid';
import { listChanged, listStaged, getRepoRoot, listCommittedChanges, getBaseBranches, getCurrentBranch } from './git.js';
import { getTargets, saveTargets, addManifest, getManifests } from './store.js';
import { uploadWithSFTP, uploadWithFTPS } from './deploy.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 9547;

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Serve frontend static files
app.use(express.static(path.join(__dirname, '../frontend/dist')));

// Health
app.get('/api/health', (req,res)=>res.json({ ok:true }));

// Targets CRUD
app.get('/api/targets', async (req,res)=> res.json(await getTargets()));
app.post('/api/targets', async (req,res)=>{ const list = await getTargets(); list.unshift({ id: uuid(), ...req.body }); await saveTargets(list); res.json(list[0]); });
app.put('/api/targets/:id', async (req,res)=>{ const list = await getTargets(); const i=list.findIndex(t=>t.id===req.params.id); if(i<0) return res.sendStatus(404); list[i]={...list[i],...req.body}; await saveTargets(list); res.json(list[i]); });
app.delete('/api/targets/:id', async (req,res)=>{ const list = await getTargets(); const n=list.filter(t=>t.id!==req.params.id); await saveTargets(n); res.json({ ok:true }); });

// Repo diffs
app.get('/api/repo/changed', async (req,res)=>{
  try {
    const { repoPath, baseRef='HEAD~1' } = req.query;
    const items = await listChanged(repoPath, baseRef);
    res.json({ items });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/repo/staged', async (req,res)=>{
  try {
    const { repoPath } = req.query;
    const items = await listStaged(repoPath);
    res.json({ items });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/repo/committed', async (req,res)=>{
  try {
    const { repoPath, baseBranch='main' } = req.query;
    const items = await listCommittedChanges(repoPath, baseBranch);
    res.json({ items });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/repo/branches', async (req,res)=>{
  try {
    const { repoPath } = req.query;
    const baseBranches = await getBaseBranches(repoPath);
    const currentBranch = await getCurrentBranch(repoPath);
    res.json({ baseBranches, currentBranch });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Deploy (creates manifest + streams progress via SSE)
app.post('/api/deploy', async (req,res)=>{
  const { repoPath, files, targetId, note, deploymentRoot } = req.body;
  const targets = await getTargets();
  const target = targets.find(t=>t.id===targetId);
  if(!target) return res.status(400).json({ error: 'Target not found' });

  // Use deploymentRoot if provided, otherwise fall back to target's remoteRoot
  const effectiveRemoteRoot = deploymentRoot || target.remoteRoot || '/';

  const root = await getRepoRoot(repoPath);
  const id = uuid();
  const manifest = { id, createdAt: new Date().toISOString(), repoRoot: root, files, targetId, note, deploymentRoot: effectiveRemoteRoot };
  await addManifest(manifest);

  // SSE progress
  res.writeHead(200, { 'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive' });
  const write = (e,d)=>res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
  write('start', { id, total: files.length, target: target.name||target.host });

  const onProgress = (p)=> write('progress', p);

  try {
    // Create a modified target with the effective remote root
    const targetWithEffectiveRoot = { ...target, remoteRoot: effectiveRemoteRoot };

    if (target.protocol === 'sftp') {
      await uploadWithSFTP(targetWithEffectiveRoot, root, files, onProgress);
    } else if (target.protocol === 'ftps') {
      await uploadWithFTPS(targetWithEffectiveRoot, root, files, onProgress);
    } else {
      throw new Error('Unsupported protocol: '+target.protocol);
    }
    write('done', { ok:true });
  } catch (err) {
    write('error', { error: err.message });
  } finally {
    res.end();
  }
});

// Replay previous manifest to a different target
app.post('/api/replay', async (req,res)=>{
  const { manifestId, targetId } = req.body;
  const manifests = await getManifests();
  const m = manifests.find(x=>x.id===manifestId);
  if(!m) return res.status(404).json({ error: 'Manifest not found' });
  const targets = await getTargets();
  const target = targets.find(t=>t.id===targetId);
  if(!target) return res.status(400).json({ error: 'Target not found' });

  res.writeHead(200, { 'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive' });
  const write = (e,d)=>res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
  write('start', { id: m.id, total: m.files.length, target: target.name||target.host, replay:true });

  try {
    // Use the stored deployment root from the manifest, fall back to target's remoteRoot
    const effectiveRemoteRoot = m.deploymentRoot || target.remoteRoot || '/';
    const targetWithEffectiveRoot = { ...target, remoteRoot: effectiveRemoteRoot };

    if (target.protocol === 'sftp') {
      await uploadWithSFTP(targetWithEffectiveRoot, m.repoRoot, m.files, (p)=>write('progress', p));
    } else if (target.protocol === 'ftps') {
      await uploadWithFTPS(targetWithEffectiveRoot, m.repoRoot, m.files, (p)=>write('progress', p));
    } else {
      throw new Error('Unsupported protocol: '+target.protocol);
    }
    write('done', { ok:true });
  } catch (err) {
    write('error', { error: err.message });
  } finally { res.end(); }
});

app.get('/api/manifests', async (req,res)=> res.json(await getManifests()));

// Test connection (without saving). Expects { protocol, host, port, user, password, key, remoteRoot }
app.post('/api/targets/test', async (req,res)=>{
  const { protocol, host, port, user, password, key, remoteRoot, ignoreCertErrors } = req.body || {};
  if(!protocol || !host) return res.status(400).json({ error:'protocol & host required' });
  try {
    if(protocol==='sftp'){
      const SftpClient = (await import('ssh2-sftp-client')).default; const c = new SftpClient();
      await c.connect({ host, port:port||22, username:user, password, privateKeyPath:key });
      // try remote root existence (optional)
      if(remoteRoot){ try { await c.exists(remoteRoot); } catch { /* ignore */ } }
      await c.end();
    } else if(protocol==='ftps') {
      const ftp = (await import('basic-ftp')).default; const client = new ftp.Client(0); client.ftp.verbose=false;

      const accessOptions = {
        host,
        user,
        password,
        secure: true,
        port: port||21
      };

      // Configure SSL options to ignore certificate errors if requested
      if (ignoreCertErrors) {
        accessOptions.secureOptions = {
          rejectUnauthorized: false,
          checkServerIdentity: () => undefined
        };
      }

      await client.access(accessOptions);
      if(remoteRoot){ try { await client.ensureDir(remoteRoot); } catch { /* ignore */ } }
      client.close();
    } else {
      return res.status(400).json({ error:'Unsupported protocol' });
    }
    res.json({ ok:true });
  } catch (e){ res.status(400).json({ error: e.message }); }
});

// Remote directory browsing - NOT IN USE (replaced by the connection-aware version below)
// This is kept for reference but not actually used since we now require a connection first
// app.get('/api/targets/:id/browse', async (req, res) => {
//   // Implementation removed to avoid confusion with the active endpoint below
// });

// Connection management
const activeConnections = new Map(); // targetId -> { client, protocol }

// Connect to target
app.post('/api/targets/:id/connect', async (req, res) => {
  const { id } = req.params;

  // Check if already connected
  if (activeConnections.has(id)) {
    return res.json({ ok: true, connected: true, message: 'Already connected' });
  }

  try {
    const targets = await getTargets();
    const target = targets.find(t => t.id === id);
    if (!target) return res.status(404).json({ error: 'Target not found' });

    if (target.protocol === 'sftp') {
      const SftpClient = (await import('ssh2-sftp-client')).default;
      const client = new SftpClient();
      await client.connect({
        host: target.host,
        port: target.port || 22,
        username: target.user,
        password: target.password,
        privateKeyPath: target.key
      });

      activeConnections.set(id, { client, protocol: 'sftp' });
      res.json({ ok: true, connected: true });

    } else if (target.protocol === 'ftps') {
      const ftp = (await import('basic-ftp')).default;
      const client = new ftp.Client(0);
      client.ftp.verbose = false;

      const accessOptions = {
        host: target.host,
        user: target.user,
        password: target.password,
        secure: true,
        port: target.port || 21
      };

      // Configure SSL options to ignore certificate errors if requested
      if (target.ignoreCertErrors) {
        accessOptions.secureOptions = {
          rejectUnauthorized: false,
          checkServerIdentity: () => undefined
        };
      }

      await client.access(accessOptions);

      activeConnections.set(id, { client, protocol: 'ftps' });
      res.json({ ok: true, connected: true });

    } else {
      res.status(400).json({ error: 'Unsupported protocol' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Disconnect from target
app.post('/api/targets/:id/disconnect', async (req, res) => {
  const { id } = req.params;

  if (!activeConnections.has(id)) {
    return res.json({ ok: true, message: 'Already disconnected' });
  }

  try {
    const connection = activeConnections.get(id);

    if (connection.protocol === 'sftp') {
      await connection.client.end();
    } else if (connection.protocol === 'ftps') {
      connection.client.close();
    }

    activeConnections.delete(id);
    res.json({ ok: true });
  } catch (error) {
    // Even if error, remove the connection
    activeConnections.delete(id);
    res.status(500).json({ error: error.message });
  }
});

// Get connection status
app.get('/api/targets/:id/status', async (req, res) => {
  const { id } = req.params;
  res.json({ connected: activeConnections.has(id) });
});

// Remote browser endpoint that uses existing connections
app.get('/api/targets/:id/browse', async (req, res) => {
  try {
    const { id } = req.params;
    const { path: remotePath = '/' } = req.query;

    const targets = await getTargets();
    const target = targets.find(t => t.id === id);
    if (!target) return res.status(404).json({ error: 'Target not found' });

    // Use existing connection if available
    const connection = activeConnections.get(id);
    if (!connection) {
      return res.status(400).json({ error: 'Not connected. Connect first.' });
    }

    let items = [];

    if (connection.protocol === 'sftp') {
      try {
        const list = await connection.client.list(remotePath || '/');

        items = list.map(item => ({
          name: item.name,
          path: remotePath === '/' ? '/' + item.name : remotePath + '/' + item.name,
          type: item.type, // '-' for file, 'd' for directory
          size: item.size,
          modifyTime: item.modifyTime
        }));
      } catch (err) {
        return res.status(500).json({ error: `Failed to list directory: ${err.message}` });
      }
    } else if (connection.protocol === 'ftps') {
      try {
        const basePath = remotePath || '/';
        await connection.client.cd(basePath);
        const list = await connection.client.list();

        items = list.map(item => ({
          name: item.name,
          path: basePath === '/' ? '/' + item.name : basePath + '/' + item.name,
          type: item.isDirectory ? 'd' : '-',
          size: item.size,
          modifyTime: item.rawModifiedAt
        }));
      } catch (err) {
        return res.status(500).json({ error: `Failed to list directory: ${err.message}` });
      }
    } else {
      return res.status(400).json({ error: 'Unsupported protocol' });
    }

    res.json({ items });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Download file endpoint
app.get('/api/targets/:id/download', async (req, res) => {
  const { id } = req.params;
  const { path: filePath } = req.query;

  if (!filePath) {
    return res.status(400).json({ error: 'File path is required' });
  }

  const connection = activeConnections.get(id);
  if (!connection) {
    return res.status(400).json({ error: 'Not connected. Connect first.' });
  }

  try {
    if (connection.protocol === 'sftp') {
      try {
        const buffer = await connection.client.get(filePath);
        const filename = path.basename(filePath);

        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.send(buffer);
      } catch (sftpError) {
        console.error('SFTP download error:', sftpError);
        throw sftpError;
      }

    } else if (connection.protocol === 'ftps') {
      const tempPath = path.join('/tmp', `download_${Date.now()}_${path.basename(filePath)}`);

      try {
        // Use a Promise wrapper for the FTP download operation
        await new Promise((resolve, reject) => {
          connection.client.downloadTo(tempPath, filePath)
            .then(resolve)
            .catch(reject);
        });

        const buffer = await fs.readFile(tempPath);

        const filename = path.basename(filePath);
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.send(buffer);
      } catch (ftpError) {
        console.error('FTP download error:', ftpError);
        throw ftpError;
      } finally {
        // Always clean up temp file
        try {
          await fs.unlink(tempPath);
        } catch (unlinkError) {
          console.warn('Failed to clean up temp file:', unlinkError.message);
        }
      }

    } else {
      res.status(400).json({ error: 'Unsupported protocol' });
    }
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Upload file endpoint
app.post('/api/targets/:id/upload', async (req, res) => {
  const { id } = req.params;
  const { path: filePath, content } = req.body;

  if (!filePath || content === undefined) {
    return res.status(400).json({ error: 'File path and content are required' });
  }

  const connection = activeConnections.get(id);
  if (!connection) {
    return res.status(400).json({ error: 'Not connected. Connect first.' });
  }

  try {
    if (connection.protocol === 'sftp') {
      try {
        // Create directory if it doesn't exist
        const dir = path.posix.dirname(filePath);
        if (dir && dir !== '/') {
          await connection.client.mkdir(dir, true); // recursive directory creation
        }

        const buffer = Buffer.from(content, 'utf8');
        await connection.client.put(buffer, filePath);
        res.json({ ok: true });
      } catch (sftpError) {
        console.error('SFTP upload error:', sftpError);
        throw sftpError;
      }

    } else if (connection.protocol === 'ftps') {
      const tempPath = path.join('/tmp', `upload_${Date.now()}_${path.basename(filePath)}`);

      try {
        await fs.writeFile(tempPath, content, 'utf8');

        // Create directory if it doesn't exist
        const dir = path.posix.dirname(filePath);
        if (dir && dir !== '/') {
          await connection.client.ensureDir(dir); // recursive directory creation
        }

        // Use a Promise wrapper for the FTP upload operation
        await new Promise((resolve, reject) => {
          connection.client.uploadFrom(tempPath, filePath)
            .then(resolve)
            .catch(reject);
        });

        res.json({ ok: true });
      } catch (ftpError) {
        console.error('FTP upload error:', ftpError);
        throw ftpError;
      } finally {
        // Always clean up temp file
        try {
          await fs.unlink(tempPath);
        } catch (unlinkError) {
          console.warn('Failed to clean up temp file:', unlinkError.message);
        }
      }    } else {
      res.status(400).json({ error: 'Unsupported protocol' });
    }
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Fallback: serve index.html for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/dist/index.html'));
});

// Clean up connections on server close
process.on('SIGINT', async () => {
  console.log('Closing all connections...');

  for (const [id, connection] of activeConnections.entries()) {
    try {
      if (connection.protocol === 'sftp') {
        await connection.client.end();
      } else if (connection.protocol === 'ftps') {
        connection.client.close();
      }
    } catch (err) {
      console.error(`Error closing connection ${id}:`, err);
    }
  }

  process.exit(0);
});

// Start server (fixed port). If occupied, exit so developer can free it.
app.listen(PORT, ()=> console.log('TwinDeploy backend on http://localhost:'+PORT))
  .on('error', err => {
    if(err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} already in use. Stop the other process or set PORT env.`);
      process.exit(1);
    } else {
      console.error('Server error:', err);
      process.exit(1);
    }
  });
