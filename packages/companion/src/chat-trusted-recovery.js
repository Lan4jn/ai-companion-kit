// Offline, explicit single-segment recovery; no generation or tool invocation.
import {createHash} from 'node:crypto';
import {DurableBatchCandidate,createBoundBatchProcessorCandidate} from './chat-durable-batch-candidate.js';
const snapshot = row => createHash('sha256').update(JSON.stringify(row)).digest('hex');
export function inspectTrustedRecovery(queue) {
 if (!(queue instanceof DurableBatchCandidate)) throw Error('batch queue required');
 queue.validate();
 return queue.journal.rows.filter(r=>r.type==='batch').map(r=>({id:r.id,session:r.session,index:r.index,state:r.state,snapshot:snapshot(r),segment:r.segments[r.index]}));
}
export async function sendTrustedRecovery({queue,bot,sealKey,ownerId,store,scope,id,session,index,state,snapshot:expected,segment}={}) {
 if (!(queue instanceof DurableBatchCandidate) || typeof expected!=='string' || !/^[a-f0-9]{64}$/.test(expected)) return {status:'blocked'};
 const row=queue.list(session)[0];
 if (!row || row.type!=='batch' || row.state!=='ready' || state!=='ready' || row.id!==id || row.index!==index || row.segments[row.index]!==segment || snapshot(row)!==expected) return {status:'blocked'};
 try { return await createBoundBatchProcessorCandidate({enabled:true,queue,bot,sealKey,ownerId,retainAcknowledged:true}).process(session,{store,scope}); }
 catch { return {status:'blocked'}; }
}
