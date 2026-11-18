// Isolated candidate only: fail-closed cooperative directory lock, not production-wired.
// SIGKILL leaves a stale lock; never remove it until all writers are independently stopped.
// Requires a trusted private directory and trustworthy local filesystem; no rollback protection.
// A claim is durable as unknown *before* any external action. No automatic retry.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { startChatRecovery } from './chat-recovery.js';

export class EncryptedChatJournal {
  constructor({directory,key}) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw Error('32-byte external key required');
    this.directory=directory; this.key=Buffer.from(key); this.file=path.join(directory,'journal.enc');
    const st=fs.lstatSync(directory);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o077)) throw Error('private owned directory required');
    this.lockPath=path.join(directory,'.journal.lock');
    try { fs.mkdirSync(this.lockPath,{mode:0o700}); } catch (e) { if(e.code==='EEXIST') throw Error('journal lock held or stale; offline operator inspection required'); throw e; }
    this.lockStat=fs.lstatSync(this.lockPath);
    try {
    this.rows=[]; this.receipts=[];
    let s; try { s=fs.lstatSync(this.file); } catch(e) { if(e.code!=='ENOENT') throw e; }
    if (s) {
      if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid() || s.nlink!==1 || (s.mode & 0o077)) throw Error('unsafe journal file');
      const fd=fs.openSync(this.file,fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      let contents;
      try { const actual=fs.fstatSync(fd); if(actual.dev!==s.dev || actual.ino!==s.ino || actual.nlink!==1 || actual.uid!==process.getuid() || (actual.mode & 0o077) || !actual.isFile()) throw Error('unsafe journal file'); contents=fs.readFileSync(fd,'utf8'); } finally { fs.closeSync(fd); }
      const blob=JSON.parse(contents);
      const decipher=createDecipheriv('aes-256-gcm',this.key,Buffer.from(blob.iv,'base64'));
      decipher.setAuthTag(Buffer.from(blob.tag,'base64'));
      const decoded=JSON.parse(Buffer.concat([decipher.update(Buffer.from(blob.data,'base64')),decipher.final()]).toString('utf8'));
      if (Array.isArray(decoded)) this.rows=decoded;
      else if (decoded && decoded.version===1 && Array.isArray(decoded.rows) && Array.isArray(decoded.receipts) && Object.keys(decoded).sort().join(',')==='receipts,rows,version') { this.rows=decoded.rows; this.receipts=decoded.receipts; }
      else throw Error('invalid journal');
    }
    } catch (e) { this.close(); throw e; }
  }
  close() {
    if (this.closed) return;
    const st=fs.lstatSync(this.lockPath);
    if (!st.isDirectory() || st.dev!==this.lockStat.dev || st.ino!==this.lockStat.ino) { this.failed=true; throw Error('journal lock replaced'); }
    fs.rmdirSync(this.lockPath); this.closed=true; this.key.fill(0);
  }
  checkLock() {
    if (this.closed || this.failed) throw Error('journal closed or failed');
    const st=fs.lstatSync(this.lockPath);
    if (!st.isDirectory() || st.dev!==this.lockStat.dev || st.ino!==this.lockStat.ino) { this.failed=true; throw Error('journal lock replaced'); }
  }
  save(rows, receipts=this.receipts) {
    this.checkLock();
    if (this.failed) throw Error('journal failed; reopen required');
    const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',this.key,iv);
    const payload=receipts.length ? {version:1,rows,receipts} : rows;
    const data=Buffer.concat([cipher.update(JSON.stringify(payload),'utf8'),cipher.final()]);
    const contents=JSON.stringify({iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')});
    const temp=path.join(this.directory,`.journal-${randomBytes(16).toString('hex')}`);
    let fd;
    try {
      fd=fs.openSync(temp,'wx',0o600); fs.writeFileSync(fd,contents); fs.fsyncSync(fd); fs.closeSync(fd); fd=undefined;
      fs.renameSync(temp,this.file);
      const dirfd=fs.openSync(this.directory,'r'); try { fs.fsyncSync(dirfd); } finally { fs.closeSync(dirfd); }
      this.rows=rows; this.receipts=receipts;
    } catch (e) { this.failed=true; if(fd!==undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch {} throw e; }
  }
  append(session,payload) {
    if (typeof session !== 'string' || !session) throw Error('session required');
    const cloned=JSON.parse(JSON.stringify(payload));
    const id=randomUUID(); this.save([...this.rows,{id,session,payload:cloned,state:'queued'}]); return id;
  }
  list(session) { this.checkLock(); return structuredClone(this.rows.filter(r=>r.session===session)); }
  claim(session) {
    this.checkLock();
    const first=this.rows.find(r=>r.session===session);
    if (!first || first.state!=='queued') return null;
    const rows=structuredClone(this.rows); const item=rows.find(r=>r.id===first.id); item.state='unknown'; item.attemptedAt=new Date().toISOString();
    this.save(rows); return structuredClone(item);
  }
  resolve(session,id,decision,evidence) {
    // No authenticated human approval channel exists for this isolated candidate.
    // Evidence text is not authorization. Retain unknown records, fail closed.
    throw Error('reconciliation disabled: authenticated human authorization not available');
  }
}

// Candidate only: OS owner access is the authorization boundary, not proof that
// a human actually checked external delivery evidence. Never expose this socket.
const recoveryOwners = new WeakSet();
export async function startDurableChatRecovery(journal, options) {
  journal.checkLock();
  // Legacy recovery deletes whole records, which is unsafe for segmented batches.
  // Recheck at each operation because the journal can change after startup.
  const checkLegacyRows = () => {
    journal.checkLock();
    if (journal.rows.some(row => row.kind !== undefined)) throw Error('incompatible batch journal');
  };
  checkLegacyRows();
  if (recoveryOwners.has(journal)) throw Error('recovery already active');
  recoveryOwners.add(journal);
  const attempts = new WeakMap();
  let snapshot = new Map();
  const queue = {
    get failed() {
      checkLegacyRows();
      const next = new Map();
      for (const row of journal.rows) {
        if (row.state === 'unknown') next.set(row.id, {id:row.id, session:row.session, attemptedAt:row.attemptedAt ?? null, active:true});
      }
      for (const [id, old] of snapshot) if (!next.has(id)) old.active = false;
      for (const [id] of next) {
        const old = snapshot.get(id);
        if (old?.active) next.set(id, old);
      }
      snapshot = next;
      return new Set(next.keys());
    },
    get undelivered() {
      return [...snapshot].map(([key, item]) => {
        const items = [{key}]; attempts.set(items,item.attemptedAt); return items;
      });
    },
    attemptTimes: attempts,
    async resolveFailure(session, decision, {onAccepted}) {
      if (decision !== 'delivered') return false;
      const expected = snapshot.get(session);
      checkLegacyRows();
      const first = journal.rows.find(row => row.session === expected?.session);
      if (!expected?.active || first?.id !== expected.id || first.state !== 'unknown') return false;
      journal.save(journal.rows.filter(row => row.id !== first.id));
      expected.active = false;
      onAccepted();
      return true;
    }
  };
  try {
    const server = await startChatRecovery(queue, options);
    return {path:server.path, async close() { try { await server.close(); } finally { recoveryOwners.delete(journal); } }};
  } catch (error) { recoveryOwners.delete(journal); throw error; }
}
