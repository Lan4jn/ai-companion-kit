import { createHash } from 'node:crypto';
import { mkdirSync, lstatSync, openSync, closeSync, constants } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withForgetWrite } from './chat-forget-coordination.js';
import {historyDependencies,validHistoryDependencies} from './chat-history-dependencies.js';
import Database from 'better-sqlite3';

const worker = fileURLToPath(new URL('./memory-brain-worker.py', import.meta.url));
const fields = ['tenant','platform','type','session','user'];
const valid = x => typeof x === 'string' && x.trim() === x && x.length > 0 && x.length <= 512;
function runWorker(python, engineRoot, request, backend = 'legacy') {
 return new Promise((resolvePromise, reject) => {
  const selectedWorker = backend === 'ame' ? fileURLToPath(new URL('../experiments/ame-synthetic/worker.py', import.meta.url)) : backend === 'sqlite-fts' ? fileURLToPath(new URL('./memory-sqlite-fts-worker.py', import.meta.url)) : worker;
  const p = spawn(python, [selectedWorker, engineRoot], {stdio:['pipe','pipe','pipe'], env:{LANG:'C.UTF-8', PATH:'/usr/bin:/bin'}});
  let out = '', err = ''; const timer = setTimeout(() => p.kill('SIGKILL'), 10000);
  p.stdout.on('data', chunk => { out += chunk; if (out.length > 1000000) p.kill('SIGKILL'); });
  p.stderr.on('data', chunk => { err += chunk; if (err.length > 100000) p.kill('SIGKILL'); });
  p.on('error', error => { clearTimeout(timer); reject(error); });
  p.on('close', code => { clearTimeout(timer); if (code !== 0) return reject(new Error('memory-brain unavailable')); try { resolvePromise(JSON.parse(out)); } catch { reject(new Error('invalid memory-brain output')); } });
  p.stdin.on('error', () => {}); p.stdin.end(JSON.stringify(request));
 });
}
export function createMemoryBrain({enabled = false, backend = 'legacy', directory, authorize, recoveryAuthorization, migrationAuthorization, verifyMigrationEvidence, python = '/usr/bin/python3', engineRoot = '/root/memory-brain', retentionMs = 30 * 86400000, maxChatHistoryTurns = 5000} = {}) {
 if (!Number.isSafeInteger(maxChatHistoryTurns) || maxChatHistoryTurns < 1 || maxChatHistoryTurns > 5000) throw new Error('invalid chat history capacity');
 if (!['legacy','ame','sqlite-fts'].includes(backend)) throw new Error('invalid memory backend');
 const run = (py, root, request) => {
  if (request.operation !== 'privateHistory' && request.operation !== 'chatHistory' && request.operation !== 'cleanup') {
   for (const item of request.scopes || [request]) if (item.path) ensureDatabase(item.path);
  }
  return runWorker(py, root, request, backend);
 };
 function ensureDatabase(path) {
  let fd, created = false;
  try { fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); created = true; }
  catch (error) { if (error.code !== 'EEXIST') throw error; fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW); }
  closeSync(fd);
  const st = lstatSync(path);
  if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o077) || st.nlink !== 1) throw new Error('unsafe memory database');
  // Only a file created exclusively by this operation is known to be empty.
  // Existing incomplete or corrupt ledgers must continue to fail closed.
  if (created && backend === 'legacy') {
   const db = new Database(path, {fileMustExist:true});
   try { db.exec('BEGIN; CREATE TABLE adapter_policy (id INTEGER PRIMARY KEY CHECK(id=1), revoked INTEGER NOT NULL); CREATE TABLE adapter_forget_tombstones (evidence_hash TEXT PRIMARY KEY); COMMIT;'); }
   finally { db.close(); }
  }
 };
 if (!Number.isSafeInteger(retentionMs) || retentionMs <= 0 || retentionMs > 30 * 86400000) throw new Error('invalid retention');
 if (enabled !== true) enabled = false;
 // Inspect the *other* backend without initializing or migrating it. The
 // coordination lock shared by forget writers is held by the caller.
 function otherForgotten(scope, source, other) {
  if (!other) {
   const all = new Set();
   for (const b of ['legacy','ame','sqlite-fts']) if (b !== backend) for (const h of otherForgotten(scope, source, b)) all.add(h);
   return all;
  }
  const hash = createHash('sha256').update(JSON.stringify([scope, source])).digest('hex');
  const file = join(directory, `${other === 'ame' ? 'ame-v1-' : other === 'sqlite-fts' ? 'sqlite-fts-v1-' : ''}${hash}.sqlite3`);
  try { lstatSync(file + '.revoked'); throw new Error('source revoked'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  let st;
  try { st = lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return new Set(); throw e; }
  if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o077) || st.nlink !== 1) throw new Error('unsafe memory database');
  const db = new Database(file, {readonly:true, fileMustExist:true});
  try {
   const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x => x.name));
   if (other !== 'legacy') {
    const prefix = other === 'ame' ? 'ame' : 'local';
    if (!tables.has(`${prefix}_identity`) || !tables.has(`${prefix}_tombstones`)) throw new Error('invalid memory ledger');
    const rows = db.prepare(`SELECT identity,retention,revoked FROM ${prefix}_identity`).all();
    if (rows.length !== 1 || rows[0].revoked !== 0 || !Number.isSafeInteger(rows[0].retention) || rows[0].retention <= 0) throw new Error('invalid AME identity');
    const id = JSON.parse(rows[0].identity);
    if (!Array.isArray(id) || id.length !== 2 || id[1] !== source || !id[0] || Object.keys(id[0]).length !== fields.length || fields.some(k => id[0][k] !== scope[k])) throw new Error('memory identity mismatch');
   } else {
    if (!tables.has('adapter_forget_tombstones') || !tables.has('adapter_policy')) throw new Error('invalid legacy ledger');
    if (db.prepare('SELECT 1 FROM adapter_policy WHERE revoked != 0 LIMIT 1').get()) throw new Error('source revoked');
    if (tables.has('memories')) for (const row of db.prepare('SELECT source,meta FROM memories').iterate()) {
     const meta = JSON.parse(row.meta);
     if (row.source !== source || !meta || meta.adapter_version !== 1 || !meta.scope || Object.keys(meta.scope).length !== fields.length || fields.some(k => meta.scope[k] !== scope[k])) throw new Error('memory identity mismatch');
    }
   }
   const rows = db.prepare(other === 'ame' ? 'SELECT digest AS hash FROM ame_tombstones' : other === 'sqlite-fts' ? 'SELECT digest AS hash FROM local_tombstones' : 'SELECT evidence_hash AS hash FROM adapter_forget_tombstones').all();
   if (rows.some(r => typeof r.hash !== 'string' || !/^[a-f0-9]{64}$/.test(r.hash))) throw new Error('invalid tombstone');
   return new Set(rows.map(r => r.hash));
  } finally { db.close(); }
 }
 const digest = evidence => createHash('sha256').update(evidence).digest('hex');
 // These two pipelines independently preserve the exact canonical thread URL:
 // web-living's source-page evidence and tieba-reader's thread URL. No text or
 // URL normalization is evidence of a relationship.
 const linkedSource = (source, evidence) => /^(?:https:\/\/tieba\.baidu\.com\/p\/(?:0|[1-9]\d*))$/.test(evidence)
  ? source === 'tieba' ? 'web-source-page' : source === 'web-source-page' ? 'tieba' : null : null;
 function linkedForgotten(scope, source, evidence) {
  const linked = linkedSource(source, evidence);
  if (!linked) {
   // A page on the thread host with a noncanonical identity may alias a
   // forgotten thread; do not guess by stripping parameters or fragments.
   if (source === 'tieba' || source === 'web-source-page') {
    try { const u = new URL(evidence); if (u.hostname === 'tieba.baidu.com' && /^\/p\//.test(u.pathname)) return true; } catch {}
   }
   return false;
  }
  // Unreadable/unverified counterpart denies only this candidate.
  try { return ['legacy','ame','sqlite-fts'].some(b => otherForgotten(scope, linked, b).has(digest(evidence))); }
  catch { return true; }
 }
 const withSources = (scope, sources, action) => {
  const locks = [...new Set(sources.flatMap(s => s === 'tieba' || s === 'web-source-page' ? ['tieba','web-source-page'] : [s]))].sort();
  const enter = i => i === locks.length ? action() : withForgetWrite(directory, scope, locks[i], () => enter(i + 1));
  return enter(0);
 };
 async function scoped(context, source, operation, preauthorized = false, existingOnly = false) {
  if (!enabled) return null;
  if (typeof authorize !== 'function' || !context || fields.some(k => !valid(context[k])) || !valid(source)) throw new Error('invalid memory scope');
  const scope = Object.fromEntries(fields.map(k => [k, context[k]]));
  if (!preauthorized && await authorize(Object.freeze({...context}), operation, source) !== true) throw new Error('memory access denied');
  // There is no independent anti-rollback authority. Every read requires a
  // fresh decision from a trusted local operator, never an on-disk marker.
  if ((operation === 'recall' || operation === 'rankCandidates' || operation === 'privateHistory' || operation === 'chatHistory') &&
      (typeof recoveryAuthorization !== 'function' || await recoveryAuthorization(Object.freeze({...scope}), operation, source) !== true)) throw new Error('recovery authorization required');
  const hash = createHash('sha256').update(JSON.stringify([scope, source])).digest('hex');
  if (!directory || !resolve(directory).startsWith('/')) throw new Error('memory directory required');
  if (!existingOnly) mkdirSync(directory, {recursive:true, mode:0o700});
  let st;
  try { st = lstatSync(directory); } catch (error) { if (existingOnly && error.code === 'ENOENT') return null; throw error; }
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o077)) throw new Error('unsafe memory directory');
  const path = join(directory, `${backend === 'ame' ? 'ame-v1-' : backend === 'sqlite-fts' ? 'sqlite-fts-v1-' : ''}${hash}.sqlite3`);
  let fd;
  const readOnlyOperation = operation === 'privateHistory' || operation === 'inspectChatHistoryReservations';
  try { fd = openSync(path, (readOnlyOperation ? constants.O_RDONLY : constants.O_RDWR) | constants.O_NOFOLLOW); }
  catch (error) { if (error.code === 'ENOENT') { if (existingOnly) return null; return {scope, path, source, retentionMs}; } throw error; }
  closeSync(fd);
  const db = lstatSync(path);
  if (!db.isFile() || db.uid !== process.getuid() || (db.mode & 0o077) || db.nlink !== 1) throw new Error('unsafe memory database');
  return {scope, path, source, retentionMs};
 }
 async function reserveChatHistory(context, turn, action, expectedHistory, dependencyKey) {
  if (backend !== 'sqlite-fts') throw new Error('atomic history reservation unavailable');
  if (!enabled || !turn || !valid(turn.turnId) || !Array.isArray(turn.events) || !turn.events.length || turn.events.length > 100 || new Set(turn.events).size !== turn.events.length || turn.events.some(e => typeof e !== 'string' || !/^onebot-message:(?:0|-?[1-9]\d*)$/.test(e)) || !valid(turn.text) || typeof turn.reply !== 'string' || !turn.reply.trim() || turn.reply.length > 6000) throw new Error('invalid chat history');
  const snapshot={turnId:turn.turnId,events:[...turn.events],text:turn.text,reply:turn.reply};
  const s=await scoped(context,'qq-private-message','reserveChatHistory');
  return withSources(s.scope,[s.source],async()=>{
   const forgotten=otherForgotten(s.scope,s.source);
   if (expectedHistory !== undefined) {
    if (!validHistoryDependencies(expectedHistory) || !Buffer.isBuffer(dependencyKey) || dependencyKey.length!==32) throw Error('invalid history provenance');
    const historyScope=await scoped(context,'qq-private-message','chatHistory',false,true);
    const rows=historyScope ? await run(python,engineRoot,{...historyScope,operation:'chatHistory',limit:20}) : [];
    if (!Array.isArray(rows) || rows.some(r=>!Array.isArray(r.events) || !r.events.length || r.events.some(e=>!valid(e)))) throw Error('invalid history provenance');
    const current=rows.filter(r=>r.events.every(e=>!forgotten.has(digest(e))));
    const actual=historyDependencies(dependencyKey,context.session,current).commitments;
    if (expectedHistory.commitments.some(expected=>!actual.includes(expected))) throw Error('generation history changed');
   }
   if (snapshot.events.some(e=>forgotten.has(digest(e)))) throw new Error('forgotten');
   const result=await run(python,engineRoot,{...s,operation:'reserveChatHistory',turn:snapshot,maxChatHistoryTurns});
   return action ? await action() : result;
  });
 }
 return {
  // Offline, one explicitly selected legacy QQ message at a time. The verifier
  // must independently bind the exact text and evidence to an original event;
  // the old adapter's metadata alone is not proof of origin.
  async migrateLegacyEvidence(context, {source, evidence} = {}) {
   // Fail closed until a single-use, durable authorization and independently
   // authenticated original-event verifier are wired at this boundary. The
   // caller-provided callbacks below are not sufficient proof on their own.
   const trustedOfflineMigrationAvailable = false;
   if (!trustedOfflineMigrationAvailable || !enabled || backend !== 'sqlite-fts' || typeof migrationAuthorization !== 'function' || typeof verifyMigrationEvidence !== 'function') throw new Error('migration disabled');
   if (!context || context.platform !== 'qq' || context.type !== 'private' || !/^[1-9]\d*$/.test(context.user || '') || context.session !== `private:${context.user}` || source !== 'qq-private-message' || typeof evidence !== 'string' || !/^onebot-message:(?:0|-?[1-9]\d*)$/.test(evidence)) throw new Error('invalid migration selection');
   const scope = Object.freeze(Object.fromEntries(fields.map(k => [k, context[k]])));
   if (fields.some(k => !valid(scope[k]))) throw new Error('invalid migration scope');
   // Decisions are made before even checking whether the selected source exists.
   // Policy callbacks are a trusted local operator boundary, not model output.
   let permitted = false;
   try { permitted = await migrationAuthorization(scope, source, evidence) === true && await authorize?.(scope, 'migrateLegacyEvidence', source) === true && await recoveryAuthorization?.(scope, 'migrateLegacyEvidence', source) === true; } catch {}
   if (!permitted) throw new Error('migration authorization required');
   return withSources(scope, [source], async () => {
    const s = await scoped(scope, source, 'migrateLegacyEvidence', true, true);
    // Existing-only lookup must not create the destination before authorization.
    // It may not exist yet, in which case construct the same scoped path safely.
    const target = s || await scoped(scope, source, 'migrateLegacyEvidence', true);
    // A narrower destination retention may not later be expanded.
    if (s) {
     const dest = new Database(s.path, {readonly:true, fileMustExist:true});
     try {
      const identity = dest.prepare('SELECT retention FROM local_identity').all();
      if (identity.length !== 1 || !Number.isSafeInteger(identity[0].retention) || identity[0].retention < retentionMs) return {status:'rejected'};
     } finally { dest.close(); }
    }
    const hash = createHash('sha256').update(JSON.stringify([scope, source])).digest('hex');
    const legacyPath = join(directory, `${hash}.sqlite3`);
    try { lstatSync(legacyPath + '.revoked'); throw new Error('migration unavailable'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    // Refuse uncheckpointed/WAL sources: opening them can create shared-memory
    // files, and immutable mode would silently ignore committed WAL contents.
    for (const suffix of ['-wal','-shm','-journal']) {
     try { lstatSync(legacyPath + suffix); throw new Error('migration unavailable'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    let st;
    try { st = lstatSync(legacyPath); } catch (e) { if (e.code === 'ENOENT') return {status:'rejected'}; throw new Error('migration unavailable'); }
    if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o077) || st.nlink !== 1) throw new Error('migration unavailable');
    const db = new Database(legacyPath, {readonly:true, fileMustExist:true});
    let record;
    try {
     db.exec('PRAGMA query_only=ON; BEGIN');
     const policy = db.prepare('SELECT revoked FROM adapter_policy WHERE id=1').get();
     if (policy && policy.revoked !== 0) throw new Error('migration unavailable');
     const tombstones = db.prepare('SELECT evidence_hash FROM adapter_forget_tombstones').all();
     if (tombstones.some(x => !/^[a-f0-9]{64}$/.test(x.evidence_hash))) throw new Error('migration unavailable');
     if (tombstones.some(x => x.evidence_hash === digest(evidence)) || otherForgotten(scope, source, 'ame').has(digest(evidence))) return {status:'forgotten'};
     const retention = db.prepare('SELECT retention_ms FROM adapter_retention WHERE id=1').get()?.retention_ms;
     if (!Number.isSafeInteger(retention) || retention <= 0) throw new Error('migration unavailable');
     // Per-entry expiry is not represented in the destination schema. Do not
     // extend a stricter source retention or shorten unrelated destination data.
     if (retention < retentionMs) return {status:'rejected'};
     const rows = db.prepare("SELECT text,source,meta,created_at FROM memories WHERE status='active' AND visibility='private' AND json_valid(meta) AND json_extract(meta,'$.evidence')=? LIMIT 2").all(evidence);
     if (rows.length !== 1) return {status:'rejected'};
     const row = rows[0], meta = JSON.parse(row.meta);
     if (row.source !== source || meta.adapter_version !== 1 || !meta.scope || Object.keys(meta.scope).length !== fields.length || fields.some(k => meta.scope[k] !== scope[k]) || !valid(row.text) || typeof row.created_at !== 'number' || !Number.isFinite(row.created_at) || row.created_at > Date.now()/1000 || row.created_at <= Date.now()/1000-Math.min(retention,retentionMs)/1000) return {status:'rejected'};
     record = Object.freeze({scope, source, evidence, text:row.text, created_at:row.created_at});
    } finally { db.close(); }
    // Verification is a trusted local integration; never use a model assertion as proof.
    if (await verifyMigrationEvidence(record) !== true) return {status:'rejected'};
    return run(python, engineRoot, {...target, operation:'migrateLegacyEvidence', record});
   }).catch(() => { throw new Error('migration unavailable'); });
  },
  // Advisory preflight: a concurrent writer can consume the last slot after this
  // check. Signed history-pending acknowledgements remain the recovery authority.
  async requireChatHistoryCapacity(context) {
   if (!enabled) throw new Error('memory disabled');
   const s=await scoped(context,'qq-private-message','requireChatHistoryCapacity');
   return withSources(s.scope,[s.source],async()=>{
    otherForgotten(s.scope,s.source);
    const result=await run(python,engineRoot,{...s,operation:'requireChatHistoryCapacity',maxChatHistoryTurns});
    if (result!==true) throw new Error('chat history capacity unavailable');
    return true;
   });
  },
  async inspectChatHistoryReservations(context) {
   if (backend !== 'sqlite-fts') throw new Error('atomic history reservation unavailable');
   if (!enabled) throw new Error('memory disabled');
   const s=await scoped(context,'qq-private-message','inspectChatHistoryReservations',false,true);
   if (typeof recoveryAuthorization !== 'function' || await recoveryAuthorization(Object.freeze({...context}), 'inspectChatHistoryReservations', 'qq-private-message') !== true) throw new Error('recovery authorization required');
   if (!s) return {reservations:[]};
   return runWorker(python,engineRoot,{...s,operation:'inspectChatHistoryReservations'},backend);
  },
  async reserveChatHistory(context, turn) { return reserveChatHistory(context,turn); },
  async withReservedChatHistorySend(context, turn, send, expectedHistory, dependencyKey) {
   if (typeof send !== 'function') throw new Error('send required');
   return reserveChatHistory(context,turn,send,expectedHistory,dependencyKey);
  },
  async commitChatHistory(context, turn) {
   if (!enabled) throw new Error('memory disabled');
   if (!turn || !valid(turn.turnId) || !Array.isArray(turn.events) || !turn.events.length || turn.events.length > 100 || new Set(turn.events).size !== turn.events.length || turn.events.some(e => typeof e !== 'string' || !/^onebot-message:-?(?:0|[1-9]\d*)$/.test(e) || e === 'onebot-message:-0') || !valid(turn.text) || typeof turn.reply !== 'string' || !turn.reply.trim() || turn.reply.length > 6000) throw new Error('invalid chat history');
   const snapshot={turnId:turn.turnId,events:[...turn.events],text:turn.text,reply:turn.reply};
   const s=await scoped(context,'qq-private-message','commitChatHistory');
   return withSources(s.scope, [s.source], async () => {
    const forgotten = otherForgotten(s.scope, s.source);
    const externalForgotten = snapshot.events.filter(e => forgotten.has(digest(e)));
    if (externalForgotten.length && backend !== 'sqlite-fts') return 'forgotten';
    return run(python,engineRoot,{...s,operation:'commitChatHistory',turn:snapshot,maxChatHistoryTurns,externalForgotten});
   });
  },
  async chatHistory(context, {limit=20} = {}) {
   if (!enabled) throw new Error('memory disabled');
   if (!Number.isInteger(limit) || limit<1 || limit>100) throw new Error('invalid history limit');
   const s=await scoped(context,'qq-private-message','chatHistory',false,true);
   return s ? withSources(s.scope, [s.source], async () => {
    const forgotten = otherForgotten(s.scope, s.source);
    const rows = await run(python,engineRoot,{...s,operation:'chatHistory',limit});
    if (!Array.isArray(rows) || rows.some(r => !Array.isArray(r.events) || !r.events.length || r.events.some(e => !valid(e)))) throw new Error('invalid history provenance');
    return rows.filter(r => r.events.every(e => !forgotten.has(digest(e))));
   }) : [];
  },
  async privateHistory(context, {limit = 12} = {}) {
   if (!enabled) return [];
   if (!context || context.platform !== 'qq' || context.type !== 'private' || !/^[1-9]\d*$/.test(context.user || '') || context.session !== `private:${context.user}` || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('invalid private history scope');
   const s = await scoped(context, 'qq-private-message', 'privateHistory', false, true);
   return s ? withSources(s.scope, [s.source], async () => {
    const forgotten = otherForgotten(s.scope, s.source);
    const rows = await run(python, engineRoot, {...s, operation:'privateHistory', limit});
    if (!Array.isArray(rows) || rows.some(r => r.source !== s.source || !valid(r.evidence))) throw new Error('invalid history provenance');
    return rows.filter(r => !forgotten.has(digest(r.evidence)) && !linkedForgotten(s.scope, r.source, r.evidence));
   }) : [];
  },
  async cleanup(context, {source} = {}) {
   if (!enabled) return 0;
   const s = await scoped(context, source, 'cleanup', false, true);
   return s ? run(python, engineRoot, {...s, operation:'cleanup'}) : 0;
  },
  async rankCandidates(context, {query, candidates, limit = 3} = {}) {
   if (!enabled) return [];
   if (!valid(query) || !Array.isArray(candidates) || candidates.length > 30 || !Number.isInteger(limit) || limit < 1 || limit > 20 || !context || fields.some(k => !valid(context[k])) || typeof authorize !== 'function') throw new Error('invalid candidate query');
   const snapshot = candidates.map(c => ({text:c?.text, source:c?.source, evidence:c?.evidence}));
   if (snapshot.some(c => !valid(c.text) || !valid(c.source) || !valid(c.evidence))) throw new Error('source and evidence required');
   const scope = Object.freeze(Object.fromEntries(fields.map(k => [k, context[k]])));
   const sources = [...new Set(snapshot.map(c => c.source))].sort();
   for (const source of sources) {
    if (await authorize(scope, 'rankCandidates', source) !== true) throw new Error('memory access denied');
   }
   const scopes = [];
   for (const source of sources) scopes.push(await scoped(scope, source, 'rankCandidates', true));
   if (!snapshot.length) return [];
   return withSources(scope, sources, async () => {
    const forgotten = new Map(sources.map(source => [source, otherForgotten(scope, source)]));
    const eligible = snapshot.filter(c => !forgotten.get(c.source).has(digest(c.evidence)) && !linkedForgotten(scope, c.source, c.evidence));
    if (!eligible.length) return [];
    return run(python, engineRoot, {operation:'rankCandidates', query, candidates:eligible, limit, scopes});
   });
  },
  async filterCandidates(context, {candidates, onAllowed} = {}) {
   if (!enabled || !Array.isArray(candidates) || candidates.length > 100) throw new Error('invalid candidate filter');
   const snapshot = candidates.map(c => ({source:c?.source, evidence:c?.evidence}));
   if (snapshot.some(c => !valid(c.source) || !valid(c.evidence))) throw new Error('source and evidence required');
   const scope = Object.freeze(Object.fromEntries(fields.map(k => [k, context?.[k]])));
   if (fields.some(k => !valid(scope[k]))) throw new Error('invalid memory scope');
   const scopes = [], sources = [...new Set(snapshot.map(c => c.source))].sort();
   for (const source of sources) scopes.push(await scoped(scope, source, 'rankCandidates'));
   if (!snapshot.length) return [];
   return withSources(scope, sources, async () => {
    const forgotten = new Map(sources.map(source => [source, otherForgotten(scope, source)]));
    const indices = await run(python, engineRoot, {operation:'filterCandidates', candidates:snapshot, scopes});
    if (!Array.isArray(indices) || indices.some(i => !Number.isInteger(i) || i < 0 || i >= snapshot.length)) throw new Error('invalid candidate result');
    const allowed = indices.filter(i => !forgotten.get(snapshot[i].source).has(digest(snapshot[i].evidence)) && !linkedForgotten(scope, snapshot[i].source, snapshot[i].evidence));
    if (onAllowed !== undefined) {
     if (typeof onAllowed !== 'function') throw new Error('invalid candidate callback');
     return onAllowed(allowed);
    }
    return allowed;
   });
  },
  async remember(context, record) {
   if (!enabled) return null;
   if (!record) throw new Error('source and evidence required');
   const snapshot = {text:record.text, source:record.source, evidence:record.evidence};
   if (!valid(snapshot.text) || !valid(snapshot.source) || !valid(snapshot.evidence)) throw new Error('source and evidence required');
   const s = await scoped(context, snapshot.source, 'remember');
   return withSources(s.scope, [s.source], () => {
    if (otherForgotten(s.scope, s.source).has(digest(snapshot.evidence)) || linkedForgotten(s.scope, s.source, snapshot.evidence)) throw new Error('evidence forgotten');
    return run(python, engineRoot, {...s, operation:'remember', record:snapshot});
   });
  },
  async revoke(context, {source} = {}) {
   if (!enabled) return 0;
   if (!valid(source)) throw new Error('source required');
   const s = await scoped(context, source, 'revoke');
   return withSources(s.scope, [source], () => run(python, engineRoot, {...s, operation:'revoke'}));
  },
  async forget(context, {source, evidence, exactSingle = false} = {}) {
   if (!enabled) return 0;
   if (!valid(source) || !valid(evidence)) throw new Error('source and evidence required');
   if ((source === 'tieba' || source === 'web-source-page') && !linkedSource(source, evidence)) {
    try { const u = new URL(evidence); if (u.hostname === 'tieba.baidu.com' && /^\/p\//.test(u.pathname)) throw new Error('ambiguous thread evidence'); }
    catch (error) { if (error.message === 'ambiguous thread evidence') throw error; }
   }
   const s = await scoped(context, source, 'forget');
   if (exactSingle && source !== 'qq-private-message') throw new Error('exact single unsupported');
   return withSources(s.scope, [source], () => run(python, engineRoot, {...s, operation:'forget', evidence, exactSingle:exactSingle === true}));
  },
  async evidenceRecords(context, {source, evidence} = {}) {
   if (!enabled || backend !== 'sqlite-fts' || !valid(source) || !Array.isArray(evidence) || evidence.length > 100 || evidence.some(e=>!valid(e)) || new Set(evidence).size !== evidence.length) throw new Error('invalid evidence query');
   const s=await scoped(context,source,'recall');
   return withSources(s.scope,[source],async()=>{
    const forgotten=otherForgotten(s.scope,source);
    const rows=await run(python,engineRoot,{...s,operation:'evidenceRecords',evidence});
    if (!Array.isArray(rows) || rows.some(r=>r.source!==source || !evidence.includes(r.evidence) || !valid(r.text))) throw new Error('invalid evidence records');
    return rows.filter(r=>!forgotten.has(digest(r.evidence)) && !linkedForgotten(s.scope,source,r.evidence));
   });
  },
  async recall(context, {query, sources, limit = 3} = {}) {
   if (!enabled) return [];
   if (!valid(query) || !Array.isArray(sources) || sources.length !== 1 || !valid(sources[0]) || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('invalid memory query');
   const s = await scoped(context, sources[0], 'recall');
   return withSources(s.scope, [s.source], async () => {
    const forgotten = otherForgotten(s.scope, s.source);
    const rows = await run(python, engineRoot, {...s, operation:'recall', query, limit});
    if (!Array.isArray(rows) || rows.some(r => r.source !== s.source || !valid(r.evidence))) throw new Error('invalid recall provenance');
    return rows.filter(r => !forgotten.has(digest(r.evidence)) && !linkedForgotten(s.scope, r.source, r.evidence));
   });
  }
 };
}
