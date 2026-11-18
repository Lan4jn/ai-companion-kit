// Offline candidate only. A local operator assertion is not delivery evidence.
import {createHmac,createHash,timingSafeEqual} from 'node:crypto';
import {DurableBatchCandidate} from './chat-durable-batch-candidate.js';
import {validHistoryDependencies} from './chat-history-dependencies.js';

function snapshot(journal, row) {
  return createHmac('sha256', journal.key).update('offline-batch-snapshot-v1\0').update(JSON.stringify(row)).digest('hex');
}
function checked(journal) {
  const store=new DurableBatchCandidate(journal);
  store.validate();
  return journal.rows;
}
export function inspectBatchJournal(journal) {
  return checked(journal).map(row => ({
    id:row.id, type:row.type, state:row.state, snapshot:snapshot(journal,row),
    ...(row.type === 'batch' ? {segments:row.segments.map((_,i)=>row.outputTags ? 'unverified-use-inspect-segments' : i < row.index ? 'confirmed-delivered' : i === row.index && row.state === 'unknown' ? 'unknown' : 'not-attempted')} : {})
  }));
}
// This records an operator's assertion for precisely one unknown segment; it
// never transmits, constructs a trusted event, or retries an uncertain action.
export function acknowledgeDeliveredSegment(journal,id,expectedSnapshot) {
  const rows=checked(journal);
  const row=rows.find(r=>r.id===id);
  if (!row || row.type !== 'batch' || row.state !== 'unknown') throw Error('unknown batch required');
  if (row.outputTags || row.positionTag) throw Error('signed batch requires bound reconciliation');
  if (typeof expectedSnapshot !== 'string' || snapshot(journal,row) !== expectedSnapshot) throw Error('snapshot mismatch');
  if (rows.find(r=>r.session===row.session)?.id !== id) throw Error('not first session entry');
  const next=structuredClone(rows); const at=next.findIndex(r=>r.id===id); const target=next[at];
  if (target.index+1 === target.segments.length) next.splice(at,1);
  else { target.index++; target.state='ready'; target.attempt=null; }
  journal.save(next);
}

// Bound reconciliation is restricted to the main durable chat seal and one owner.
const seal = j => createHmac('sha256',j.key).update('main-local-onebot-seal-v1').digest();
const tag = (key,domain,data) => createHmac('sha256',key).update(domain+'\0').update(JSON.stringify(data)).digest('hex');
const equal = (a,b) => typeof a==='string' && /^[a-f0-9]{64}$/.test(a) && timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
const position = (key,r) => tag(key,'companion-batch-position-v1',[r.id,r.session,r.state,r.attempt,r.index,r.outputTags]);
const resume = (key,r) => tag(key,'offline-explicit-resume-v1',[r.id,r.session,r.state,r.index,r.positionTag]);
const inputApproval = (key,r) => tag(key,'offline-accepted-approval-v1',[r.id,r.session,r.state,r.input]);
export function hasAuthorizedInput(journal,row) {
 const key=seal(journal); try { return row?.type==='input' && row.state==='accepted' && equal(row.approvalTag,inputApproval(key,row)); } finally { key.fill(0); }
}
function verifyAccepted(journal,id,ownerId) {
 if (!/^[1-9]\d*$/.test(ownerId || '')) throw Error('owner required');
 const rows=checked(journal), row=rows.find(r=>r.id===id), key=seal(journal);
 try {
  if (!row || row.type!=='input' || row.state!=='accepted' || rows.find(r=>r.session===row.session)?.id!==id) throw Error('first accepted input required');
  const input=row.input, m=input?.message;
  if (!m || input.kind!=='transport-bound-v1' || Object.keys(input).sort().join(',')!=='kind,message,tag' || Object.keys(m).sort().join(',')!=='conversation,messageId,sender,text,transport' || m.transport!=='onebot-qq' || m.sender!==ownerId || m.conversation!==`private:${ownerId}` || !/^(?:0|[1-9]\d*|-[1-9]\d*)$/.test(m.messageId) || typeof m.text!=='string' || !m.text || !equal(input.tag,tag(key,'companion-transport-bound-v1',m))) throw Error('input binding mismatch');
  if (row.session!=='transport-bound-v1:'+createHash('sha256').update(JSON.stringify([m.transport,m.conversation])).digest('hex')) throw Error('session mismatch');
  return row;
 } finally { key.fill(0); }
}
export function inspectAcceptedInput(journal,id,ownerId) {
 const row=verifyAccepted(journal,id,ownerId);
 return {id:row.id,state:row.state,message:structuredClone(row.input.message),snapshot:snapshot(journal,row),approved:hasAuthorizedInput(journal,row)};
}
export function authorizeAcceptedInput(journal,{id,ownerId,snapshot:expected,confirmNotGenerated,confirmTrustedIngress}={}) {
 const row=verifyAccepted(journal,id,ownerId);
 if (hasAuthorizedInput(journal,row) || !equal(expected,snapshot(journal,row)) || confirmNotGenerated!==true || confirmTrustedIngress!==true) throw Error('explicit scoped approval required');
 const rows=structuredClone(journal.rows), target=rows.find(r=>r.id===id), key=seal(journal);
 try { target.approvalTag=inputApproval(key,target); journal.save(rows); } finally { key.fill(0); }
}
export function hasAuthorizedResume(journal,row) {
 const key=seal(journal); try { return row?.state==='ready' && validHistoryDependencies(row.history) && equal(row.resumeTag,resume(key,row)) && equal(row.positionTag,position(key,row)); } finally {key.fill(0);}
}
function verifyBound(journal,id,ownerId) {
 if (!/^[1-9]\d*$/.test(ownerId || '')) throw Error('owner required');
 const rows=checked(journal), row=rows.find(r=>r.id===id), key=seal(journal);
 try {
  if (!row || row.type!=='batch' || rows.find(r=>r.session===row.session)?.id!==id || !Array.isArray(row.inputIds) || row.inputIds.length!==row.inputs.length || new Set(row.inputIds).size!==row.inputIds.length || row.inputIds.some(x=>typeof x!=='string'||!x) || !Array.isArray(row.outputTags) || row.outputTags.length!==row.segments.length) throw Error('invalid bound batch');
  for (const input of row.inputs) {
   const m=input?.message;
   if (!m || input.kind!=='transport-bound-v1' || Object.keys(input).sort().join(',')!=='kind,message,tag' || Object.keys(m).sort().join(',')!=='conversation,messageId,sender,text,transport' || m.transport!=='onebot-qq' || m.sender!==ownerId || m.conversation!==`private:${ownerId}` || row.destination!==m.conversation || !/^-?\d+$/.test(m.messageId) || typeof m.text!=='string' || !m.text || !equal(input.tag,tag(key,'companion-transport-bound-v1',m))) throw Error('input binding mismatch');
   if (row.session!=='transport-bound-v1:'+createHash('sha256').update(JSON.stringify([m.transport,m.conversation])).digest('hex')) throw Error('session mismatch');
  }
  const progressValid=row.state==='history-pending' ? equal(row.ackTag,tag(key,'companion-history-ack-v1',[row.id,row.session,row.state,row.inputIds,row.inputs,row.destination,row.segments,row.outputTags])) : equal(row.positionTag,position(key,row));
  if (row.segments.some((s,i)=>!equal(row.outputTags[i],tag(key,'companion-generated-batch-v1',[row.id,row.session,row.inputIds,row.inputs,row.destination,row.segments,i,s,...(row.history===undefined?[]:[row.history])]))) || !progressValid) throw Error('output binding mismatch');
  return row;
 } finally {key.fill(0);}
}
export function inspectBoundBatch(journal,id,ownerId) {
 const row=verifyBound(journal,id,ownerId);
 return {id:row.id,state:row.state,snapshot:snapshot(journal,row),segments:row.segments.map((text,i)=>({index:i,text,status:row.state==='history-pending'||i<row.index?'confirmed-delivered':i===row.index && row.state==='unknown'?'unknown':'not-attempted'}))};
}
// Correlate the authenticated journal with a scoped SQLite reservation. This is
// only an observation; neither a ready marker nor operator input proves that
// the journal has not been rolled back. No release authority is conferred.
export async function inspectReservationBatch(journal,{id,ownerId,scope,store}={}) {
 const row=verifyBound(journal,id,ownerId);
 const initialSnapshot=snapshot(journal,row);
 if (!scope || Object.keys(scope).sort().join(',')!=='platform,session,tenant,type,user' || scope.platform!=='qq' || scope.type!=='private' || scope.user!==ownerId || scope.session!==row.destination || typeof scope.tenant!=='string' || !scope.tenant) throw Error('scope mismatch');
 if (typeof store?.inspectChatHistoryReservations!=='function') throw Error('reservation diagnostic unavailable');
 const messages=row.inputs.map(x=>x.message);
 const turn={turnId:row.id,events:messages.map(m=>`onebot-message:${m.messageId}`),text:messages.map(m=>m.text).join('\n'),reply:row.segments.join('')};
 const hash=x=>createHash('sha256').update(x).digest('hex');
 const turnHash=hash(row.id), payloadHash=hash(JSON.stringify(turn));
 const observed=await store.inspectChatHistoryReservations(scope);
 const current=verifyBound(journal,id,ownerId);
 if (!equal(snapshot(journal,current),initialSnapshot)) throw Error('journal changed during reservation inspection');
 const matches=observed.reservations.filter(x=>x.turnHash===turnHash);
 const reservation=matches.length===0?'absent':matches.length===1 && matches[0].payloadHash===payloadHash?'matched':'conflict';
 const delivery=row.state==='history-pending'?'journal-confirmed-delivered':row.state==='unknown'?'unknown':row.index===0?'journal-not-attempted':'journal-partially-delivered';
 return {id:row.id,snapshot:snapshot(journal,row),reservation,delivery,release:'disabled'};
}
export function authorizeReadyBatch(journal,{id,ownerId,snapshot:expected,confirmSend}={}) {
 const row=verifyBound(journal,id,ownerId);
 if (!validHistoryDependencies(row.history)) throw Error('generation history provenance unavailable');
 if (row.state!=='ready' || row.index!==0 || row.attempt!==null || !equal(expected,snapshot(journal,row)) || confirmSend!==true || hasAuthorizedResume(journal,row)) throw Error('explicit ready approval required');
 const rows=structuredClone(journal.rows), target=rows.find(r=>r.id===id), key=seal(journal);
 try { target.resumeTag=resume(key,target); journal.save(rows); } finally { key.fill(0); }
}
export function reconcileBoundSegment(journal,{id,ownerId,snapshot:expected,decision,authorizeResume}={}) {
 const row=verifyBound(journal,id,ownerId);
 // An uncertain send is never retryable, even on an operator assertion.
 if (row.index < row.segments.length-1 && !validHistoryDependencies(row.history)) throw Error('generation history provenance unavailable');
 if (row.state!=='unknown' || !equal(expected,snapshot(journal,row)) || decision!=='delivered' || authorizeResume!==true) throw Error('explicit scoped reconciliation required');
 const rows=structuredClone(journal.rows), target=rows.find(r=>r.id===id), key=seal(journal);
 try {
  if (decision==='delivered' && target.index===target.segments.length-1) {
   target.state='history-pending'; target.attempt=null;
   target.ackTag=tag(key,'companion-history-ack-v1',[target.id,target.session,target.state,target.inputIds,target.inputs,target.destination,target.segments,target.outputTags]);
   const done=new Set(target.inputIds);
   journal.save(rows,journal.receipts.map(r=>done.has(r.id)?{...r,state:'delivered'}:r));
  } else {
   if (decision==='delivered') target.index++;
   target.state='ready'; target.attempt=null; target.positionTag=position(key,target); target.resumeTag=resume(key,target);
   journal.save(rows);
  }
 } finally {key.fill(0);}
}
