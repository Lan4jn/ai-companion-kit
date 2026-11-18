// Candidate-only API: expose only behind a trusted administrative boundary.
import {createMemoryBrain} from './memory-brain-adapter.js';

export function createMemoryManager({authorizeManagement, migrationAudit, ...options} = {}) {
 const brain = createMemoryBrain(options);
 async function perform(operation, input) {
  if (options.enabled !== true || typeof authorizeManagement !== 'function' || !input) throw new Error('management access denied');
  const snapshot = Object.freeze({context:Object.freeze({...input.context}), source:input.source, evidence:input.evidence, exactSingle:input.exactSingle === true});
  if (await authorizeManagement(operation, snapshot) !== true) throw new Error('management access denied');
  try {
   if (operation === 'revoke') await brain.revoke(snapshot.context, {source:snapshot.source});
   else await brain.forget(snapshot.context, {source:snapshot.source, evidence:snapshot.evidence, exactSingle:snapshot.exactSingle});
  } catch (error) {
   if (error?.code === 'FORGET_LOCK_TIMEOUT') throw Object.assign(new Error('遗忘或撤销未完成：等待协调锁超时，请稍后重试。'), {code:'FORGET_LOCK_TIMEOUT'});
   throw new Error('memory management failed');
  }
  return {ok:true};
 }
 async function migrate(input) {
  if (options.enabled !== true || typeof authorizeManagement !== 'function' || typeof migrationAudit !== 'function' || !input) throw new Error('management access denied');
  const snapshot=Object.freeze({context:Object.freeze({...input.context}),source:input.source,evidence:input.evidence});
  if (await authorizeManagement('migrateLegacyEvidence',snapshot) !== true) throw new Error('management access denied');
  try { await migrationAudit(Object.freeze({operation:'migrateLegacyEvidence',phase:'attempt'})); }
  catch { throw new Error('migration audit unavailable'); }
  let result;
  try { result=await brain.migrateLegacyEvidence(snapshot.context,{source:snapshot.source,evidence:snapshot.evidence}); }
  catch {
   try { await migrationAudit(Object.freeze({operation:'migrateLegacyEvidence',phase:'error'})); } catch {}
   throw new Error('memory migration failed');
  }
  try { await migrationAudit(Object.freeze({operation:'migrateLegacyEvidence',phase:'result',status:result.status})); }
  catch { throw new Error('migration outcome uncertain: audit unavailable'); }
  return result;
 }
 return Object.freeze({revoke: input => perform('revoke', input), forget: input => perform('forget', input), migrateLegacyEvidence:migrate});
}
