import SftpClient from 'ssh2-sftp-client';
import ftp from 'basic-ftp';
import fs from 'fs/promises';
import path from 'path';
import mime from 'mime';

export async function uploadWithSFTP(target, root, files, onProgress) {
  const sftp = new SftpClient();
  await sftp.connect({ host: target.host, username: target.user, privateKeyPath: target.key, password: target.password, port: target.port || 22 });
  try {
    for (let i=0;i<files.length;i++) {
      const rel = files[i];
      const src = path.join(root, rel);
      const dst = path.posix.join(target.remoteRoot.replaceAll('\\','/'), rel.split(path.sep).join('/'));
      const dir = path.posix.dirname(dst);
      await sftp.mkdir(dir, true);
      await sftp.fastPut(src, dst);
      onProgress?.({ index:i+1, total:files.length, file: rel });
    }
  } finally {
    sftp.end();
  }
}

export async function uploadWithFTPS(target, root, files, onProgress) {
  const client = new ftp.Client(0);
  client.ftp.verbose = false;

  try {
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
        checkServerIdentity: () => undefined // Bypass hostname verification
      };
    }

    await client.access(accessOptions);
    await client.ensureDir(target.remoteRoot);
    for (let i=0;i<files.length;i++) {
      const rel = files[i];
      const src = path.join(root, rel);
      const remotePath = path.posix.join(target.remoteRoot.replaceAll('\\','/'), rel.split(path.sep).join('/'));
      const dir = path.posix.dirname(remotePath);
      await client.ensureDir(dir);
      await client.uploadFrom(src, remotePath);
      onProgress?.({ index:i+1, total:files.length, file: rel });
    }
  } finally {
    client.close();
  }
}
