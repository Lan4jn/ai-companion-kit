import {createManagedMemoryBrain,assertManagedStoreReady} from './memory-brain-trust.js';
import {biliDMScope} from './bili-dm-ledger.js';

// Operator supplies explicit account and peer allowlist; authenticated nav and
// session identities are independently checked by the transport before use.
export function createBiliDMMemory(config={}) {
 if (config.enabled !== true) return null;
 const {directory,account,peers}=config;
 if (!/^[1-9]\d*$/.test(account || '') || !Array.isArray(peers) || !peers.length || peers.some(p=>typeof p!=='string' || !/^[1-9]\d*$/.test(p) || p===account) || new Set(peers).size!==peers.length) throw Error('invalid Bili DM authorization');
 assertManagedStoreReady(directory);
 const stores=new Map(peers.map(peer=>[peer,createManagedMemoryBrain({directory,scope:biliDMScope(account,peer),sources:['bili-private-message'],trustedProcess:true,backend:'sqlite-fts'})]));
 function bound(scope) {
  const store=stores.get(scope?.user), expected=biliDMScope(account,scope?.user);
  if (!store || Object.keys(expected).some(k=>scope[k]!==expected[k]) || Object.keys(scope).length!==Object.keys(expected).length) throw Error('Bili DM scope denied');
  return store;
 }
 return Object.freeze({
  remember:async(scope,record)=>bound(scope).remember(scope,record),
  evidenceRecords:async(scope,query)=>bound(scope).evidenceRecords(scope,query),
  filterCandidates:async(scope,query)=>bound(scope).filterCandidates(scope,query),
 });
}
