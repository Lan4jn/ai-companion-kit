// Bili DM delivery ledger. Same-UID code and the authenticated session are trusted.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export const biliDMScope = (account, peer) => ({tenant:'companion',platform:'bilibili',type:'private',session:`private:bili:${account}:${peer}`,user:peer});
export const biliDMEvidence = (account, peer, id) => `bili-dm:${account}:${peer}:${id}`;
const source = 'bili-private-message';
const validId = x => /^[1-9]\d*$/.test(x);

export function openBiliDMLedger(account, peer) {
 if (!validId(account) || !validId(peer) || account === peer) throw Error('invalid DM scope');
 const dir = path.join(process.env.HOME || '/root', '.bili-ai', 'dm-ledger');
 fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const st=fs.lstatSync(dir);
 if (!st.isDirectory() || st.isSymbolicLink() || st.uid!==process.getuid() || (st.mode & 0o077)) throw Error('unsafe DM ledger');
 const file=path.join(dir,'ledger.sqlite3');
 let fd;
 try { fd=fs.openSync(file,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_RDWR|fs.constants.O_NOFOLLOW,0o600); }
 catch(e) { if(e.code!=='EEXIST') throw e; fd=fs.openSync(file,fs.constants.O_RDWR|fs.constants.O_NOFOLLOW); }
 fs.closeSync(fd);
 const info=fs.lstatSync(file);
 if(!info.isFile() || info.uid!==process.getuid() || (info.mode&0o077) || info.nlink!==1) throw Error('unsafe DM ledger');
 const db=new Database(file); db.pragma('journal_mode = DELETE'); db.pragma('synchronous = FULL');
 db.exec(`CREATE TABLE IF NOT EXISTS attempts (account TEXT NOT NULL, peer TEXT NOT NULL, event TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('unknown','sent')), PRIMARY KEY(account,peer,event));
 CREATE TABLE IF NOT EXISTS observations (seq INTEGER PRIMARY KEY, account TEXT NOT NULL, peer TEXT NOT NULL, evidence TEXT NOT NULL, source TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','assistant')), UNIQUE(account,peer,evidence));`);
 // Legacy ledgers contained private text. Remove it, including free pages.
 if (db.prepare('PRAGMA table_info(observations)').all().some(c=>c.name==='text')) {
  db.pragma('secure_delete = ON');
  db.exec('BEGIN IMMEDIATE; CREATE TABLE observations_new (seq INTEGER PRIMARY KEY, account TEXT NOT NULL, peer TEXT NOT NULL, evidence TEXT NOT NULL, source TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN (\'user\',\'assistant\')), UNIQUE(account,peer,evidence)); INSERT INTO observations_new SELECT seq,account,peer,evidence,source,role FROM observations; DROP TABLE observations; ALTER TABLE observations_new RENAME TO observations; COMMIT; VACUUM;');
 }
 for (const d of [path.dirname(path.dirname(dir)), path.dirname(dir), dir]) {
  const dfd=fs.openSync(d,'r'); try {fs.fsyncSync(dfd);} finally {fs.closeSync(dfd);}
 }
 let historyEvidence=[];
 return {
  pending(messages) { return messages.filter(m=>!db.prepare('SELECT 1 FROM attempts WHERE account=? AND peer=? AND event=?').get(account,peer,m.id)); },
  reserve(messages) { return db.transaction(()=>{ const stmt=db.prepare("INSERT INTO attempts VALUES (?,?,?,'unknown')"); for(const m of messages) stmt.run(account,peer,m.id); return true; }).immediate(); },
  sent(messages) { db.transaction(()=>{for(const m of messages) if(db.prepare("UPDATE attempts SET status='sent' WHERE account=? AND peer=? AND event=? AND status='unknown'").run(account,peer,m.id).changes!==1) throw Error('invalid reservation');}).immediate(); },
  async observe(store, id, role, text) {
   if (!validId(id) || !['user','assistant'].includes(role) || typeof text!=='string' || !text || text.length>512 || text.trim()!==text) throw Error('invalid observation');
   const evidence=biliDMEvidence(account,peer,id), scope=biliDMScope(account,peer);
   if (!await store.remember(scope,{source,evidence,text})) throw Error('memory unavailable');
   const old=db.prepare('SELECT source,role FROM observations WHERE account=? AND peer=? AND evidence=?').get(account,peer,evidence);
   if(old && (old.source!==source || old.role!==role)) throw Error('observation conflict');
   if(!old) db.prepare('INSERT INTO observations(account,peer,evidence,source,role) VALUES (?,?,?,?,?)').run(account,peer,evidence,source,role);
  },
  async history(store, excluded=[]) {
   const rows=db.prepare('SELECT evidence,source,role FROM observations WHERE account=? AND peer=? ORDER BY seq DESC LIMIT 40').all(account,peer).reverse().filter(r=>!excluded.includes(r.evidence));
   if(rows.some(r=>r.source!==source || !r.evidence.startsWith(`bili-dm:${account}:${peer}:`) || !validId(r.evidence.slice(`bili-dm:${account}:${peer}:`.length)) || !['user','assistant'].includes(r.role))) throw Error('invalid observation');
   if(!rows.length) return [];
   const found=await store.evidenceRecords(biliDMScope(account,peer),{source,evidence:rows.map(r=>r.evidence)});
   if (!Array.isArray(found) || new Set(found.map(r=>r.evidence)).size!==found.length) throw Error('invalid memory provenance');
   const byEvidence=new Map(found.map(r=>[r.evidence,r]));
   historyEvidence=rows.filter(r=>byEvidence.has(r.evidence)).map(r=>r.evidence);
   return rows.flatMap(r=>byEvidence.has(r.evidence) ? [{role:r.role,content:byEvidence.get(r.evidence).text}] : []);
  },
  async guardedSend(store, messages, send) {
   const evidence=[...new Set([...historyEvidence,...messages.map(m=>biliDMEvidence(account,peer,m.id))])];
   return store.filterCandidates(biliDMScope(account,peer),{candidates:evidence.map(evidence=>({source,evidence})),onAllowed:allowed=>{
    if (allowed.length!==evidence.length || new Set(allowed).size!==evidence.length) throw Error('memory forgotten during delivery');
    this.reserve(messages);
    return send();
   }});
  },
  close(){db.close();}
 };
}
