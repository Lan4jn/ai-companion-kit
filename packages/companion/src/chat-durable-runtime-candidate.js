// Isolated opt-in candidate: not wired to production. No automatic startup replay.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { EncryptedChatJournal } from './chat-durable-journal-candidate.js';

export function checkKeyParent(keyPath) {
  if (typeof keyPath !== 'string' || !path.isAbsolute(keyPath) || path.basename(keyPath) === '.') throw Error('absolute key path required');
  // Ancestors must not be replaceable by other users, or traverse symlinks.
  let parent = path.dirname(keyPath);
  while (true) {
    const st = fs.lstatSync(parent);
    if (!st.isDirectory() || st.isSymbolicLink() || ![0, process.getuid()].includes(st.uid) || (st.mode & 0o022)) throw Error('unsafe key directory');
    const next = path.dirname(parent); if (next === parent) break; parent = next;
  }
}

// Explicit offline initialization only. Never overwrite an existing key, including
// a dangling symlink. A published key is retained if subsequent fsync fails.
export function initializeDurableChatKey(keyPath, {directory} = {}) {
  checkKeyParent(keyPath);
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw Error('absolute journal directory required');
  checkKeyParent(path.join(directory, 'journal.enc'));
  const st=fs.lstatSync(directory);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o077)) throw Error('private journal directory required');
  if (path.dirname(keyPath) === directory) throw Error('key must be outside journal directory');
  const lock=path.join(directory,'.journal.lock');
  try { fs.mkdirSync(lock,{mode:0o700}); } catch (e) { if (e.code === 'EEXIST') throw Error('journal lock held or stale'); throw e; }
  let keyCreationStarted=false, completed=false;
  try {
    if (fs.readdirSync(directory).some(name => name !== '.journal.lock')) throw Error('journal directory must be empty');
    if (fs.readdirSync(path.dirname(keyPath)).some(name => name.startsWith('.chat-key-'))) throw Error('unfinished key initialization requires offline inspection');
    try { fs.lstatSync(keyPath); throw Error('key already exists'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    keyCreationStarted=true;
    initializeEmptyKey(keyPath);
    completed=true;
  } finally { if (!keyCreationStarted || completed) fs.rmdirSync(lock); }
}

function initializeEmptyKey(keyPath) {
  const parent=path.dirname(keyPath);
  const temp=path.join(parent, `.chat-key-${randomBytes(16).toString('hex')}`);
  const key=randomBytes(32);
  let fd, created=false;
  try {
    fd=fs.openSync(temp,fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,0o600);
    created=true;
    fs.writeFileSync(fd,key); fs.fsyncSync(fd); fs.closeSync(fd); fd=undefined;
    fs.linkSync(temp,keyPath); // atomic publication without replacement
    fs.unlinkSync(temp); created=false;
    const dirfd=fs.openSync(parent,fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(dirfd); } finally { fs.closeSync(dirfd); }
  } finally {
    key.fill(0);
    if (fd !== undefined) fs.closeSync(fd);
    if (created) { try { fs.unlinkSync(temp); } catch {} }
  }
}

export function loadKey(keyPath) {
  checkKeyParent(keyPath);
  const fd = fs.openSync(keyPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid() || st.nlink !== 1 || (st.mode & 0o077) || st.size !== 32) throw Error('unsafe key file');
    const key = Buffer.alloc(32);
    try {
      let offset = 0; while (offset < key.length) { const n = fs.readSync(fd,key,offset,key.length-offset,offset); if (!n) throw Error('short key'); offset += n; }
      return key;
    } catch (error) { key.fill(0); throw error; }
  } finally { fs.closeSync(fd); }
}

export function openDurableChatCandidate({directory, keyPath, run}) {
  if (typeof run !== 'function') throw Error('run required');
  const key = loadKey(keyPath);
  let journal;
  try { journal = new EncryptedChatJournal({directory,key}); } finally { key.fill(0); }
  const active = new Set();
  let closed = false;
  return {
    add(session,payload) { if (closed) throw Error('closed'); return journal.append(session,payload); },
    list(session) { if (closed) throw Error('closed'); return journal.list(session); },
    async process(session) {
      if (closed) throw Error('closed');
      if (active.has(session)) return false;
      active.add(session);
      try {
        const row = journal.claim(session);
        if (!row) return false;
        let result;
        try { result = await run(row.payload); } catch { return false; }
        // Only explicitly confirmed full completion can retire the claimed item.
        if (result?.ok !== true || (result.outcome !== undefined && result.outcome !== 'delivered') || result.partial === true) return false;
        journal.checkLock();
        const current = journal.rows.find(r => r.id === row.id);
        if (!current || current.state !== 'unknown' || current.session !== session) throw Error('journal state changed');
        journal.save(journal.rows.filter(r => r.id !== row.id));
        return true;
      } finally { active.delete(session); }
    },
    close() { if (closed) return; if (active.size) throw Error('active processing'); try { journal.close(); } finally { closed = true; journal.key.fill(0); } }
  };
}
