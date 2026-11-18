// Local-only, owner-protected recovery. No chat content or session identifiers leave this process.
import { mkdir, lstat, rmdir, chmod } from 'node:fs/promises';
import { createServer } from 'node:net';
import { randomBytes, createHmac } from 'node:crypto';
import { dirname, join, resolve, parse } from 'node:path';

export const defaultRecoveryDirectory = () => `/run/companion-chat-recovery-${process.getuid()}`;

export async function startChatRecovery(queue, { directory = defaultRecoveryDirectory() } = {}) {
  const uid = process.getuid();
  const absolute = resolve(directory);
  let current = parse(absolute).root;
  const parts = dirname(absolute).slice(current.length).split('/').filter(Boolean);
  for (const part of parts) {
    current = join(current, part);
    const parent = await lstat(current);
    if (!parent.isDirectory() || parent.isSymbolicLink() || ![0, uid].includes(parent.uid) || (parent.mode & 0o022)) throw new Error('unsafe recovery parent');
  }
  // Exclusive creation prevents following an attacker-controlled directory or stale socket.
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) {
    // 上次运行留下的目录是正常的；只有 EEXIST 才继续，其它错误照旧抛出
    if (error.code !== 'EEXIST') throw error;
  }
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077)) throw new Error('unsafe recovery directory');
  const path = join(directory, 'control.sock');
  const ids = new Map();
  // Ephemeral keyed fingerprints cannot be reverse-enumerated without this key.
  const fingerprintKey = randomBytes(32);
  const resolving = new Set();
  function entries() {
    // failed 可能是 Set（旧）或 Map（带隔离时间戳），两种都要能取到会话 key
    const failedKeys = typeof queue.failed?.keys === 'function' ? [...queue.failed.keys()] : [...(queue.failed || [])];
    for (const key of ids.keys()) if (!failedKeys.includes(key)) ids.delete(key);
    for (const key of failedKeys) if (!ids.has(key) && !resolving.has(key)) ids.set(key, randomBytes(24).toString('hex'));
    return [...ids].map(([key,id]) => {
      const failure = queue.undelivered?.find(items => items[0].key === key);
      return {id, status:'delivery-unknown', sessionFingerprint:createHmac('sha256', fingerprintKey).update(String(key)).digest('hex').slice(0,24), attemptedAt: failure ? queue.attemptTimes?.get(failure) ?? null : null};
    });
  }
  const connections = new Set();
  const server = createServer({allowHalfOpen:true}, socket => {
    connections.add(socket); socket.on('close', () => connections.delete(socket));
    socket.setTimeout(5000, () => socket.destroy()); socket.on('error', () => {});
    let buffer = ''; let handled = false;
    socket.on('data', async chunk => {
      if (handled) return;
      buffer += chunk.toString();
      if (buffer.length > 2048) { handled = true; socket.destroy(); return; }
      if (!buffer.includes('\n')) return;
      handled = true;
      let result = {ok:false};
      try {
        const msg = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
        if (msg.action === 'list') result = {ok:true, entries:entries()};
        else if (msg.action === 'resolve' && ['delivered','discard'].includes(msg.decision) && typeof msg.id === 'string') {
          entries();
          const key = [...ids].find(([,id]) => id === msg.id)?.[0];
          if (key !== undefined) {
            // Invalidate the capability before awaiting; a later failure gets a new ID.
            ids.delete(key);
            resolving.add(key);
            let ok;
            try {
              ok = await new Promise(resolve => {
                const task = queue.resolveFailure(key, 'delivered', {onAccepted: () => { resolving.delete(key); resolve(true); }});
                task.then(resolve, () => resolve(false));
              });
            } finally { resolving.delete(key); }
            result = {ok};
          }
        }
      } catch { /* Never log requests or errors containing private input. */ }
      socket.end(JSON.stringify(result) + '\n');
    });
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
    await chmod(path, 0o600);
  } catch (error) {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rmdir(directory).catch(() => {});
    throw error;
  }
  return {path, async close() {
    for (const socket of connections) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    // node removes its own socket on close; remove only our empty directory.
    await rmdir(directory).catch(() => {});
  }};
}
