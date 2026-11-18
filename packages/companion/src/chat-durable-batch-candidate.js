// Isolated synthetic candidate; not connected to chat ingress or production recovery.
// Claims are committed before effects. Ambiguous results require offline reconciliation.
import { Memory } from './memory.js';
import { classifyDeliveryCandidate } from './chat-delivery-candidate.js';
import { randomUUID, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { snapshotOneBotPrivateMessage, snapshotOneBotDurableIdentity } from './transport-onebot.js';
import { ChatBatchQueue } from './chat-batch-queue.js';
import { cleanAllToolArtifacts } from './safety.js';
import {safeReplyParts} from './chat-concise-delivery.js';
import {historyDependencies,validHistoryDependencies} from './chat-history-dependencies.js';

const VERSION = 1;
const clone = value => structuredClone(value);
const validSession = session => typeof session === 'string' && session.length > 0;
const DEFAULT_LIMITS = Object.freeze({maxInputs:1000, maxInputsPerSession:100, maxInputBytes:65536, maxSegments:100, maxSegmentBytes:65536, maxJournalBytes:8388608, maxSessionBytes:512});
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
// Only the trusted generator closure can mint a formation authorization.
const formationCapabilities = new WeakMap();
const completionCapabilities = new WeakMap();
const claimCapabilities = new WeakMap();
const preGenerationCapabilities = new WeakMap();
const ingressCapabilities = new WeakMap();
const historyCapabilities = new WeakMap();
const generationTag = (key,row) => createHmac('sha256',key).update('companion-generation-unknown-v1\0').update(JSON.stringify([row.id,row.session,row.state,row.inputIds,row.inputs,row.destination])).digest('hex');
const positionTag = (key,batch) => createHmac('sha256',key).update('companion-batch-position-v1\0').update(JSON.stringify([batch.id,batch.session,batch.state,batch.attempt,batch.index,batch.outputTags])).digest('hex');
const ackTag = (key,batch) => createHmac('sha256',key).update('companion-history-ack-v1\0').update(JSON.stringify([batch.id,batch.session,batch.state,batch.inputIds,batch.inputs,batch.destination,batch.segments,batch.outputTags])).digest('hex');
const outputTag = (key, batch, index, destination) => createHmac('sha256',key)
  .update('companion-generated-batch-v1\0')
  .update(JSON.stringify([batch.id,batch.session,batch.inputIds,batch.inputs,destination,batch.segments,index,batch.segments[index],...(batch.history===undefined?[]:[batch.history])]))
  .digest('hex');

export class DurableBatchCandidate {
  #claims = new WeakMap();
  constructor(journal, limits = {}) {
    if (!limits || typeof limits !== 'object' || Array.isArray(limits) || Object.keys(limits).some(k => !Object.hasOwn(DEFAULT_LIMITS,k))) throw Error('invalid capacity limits');
    this.limits = Object.freeze({...DEFAULT_LIMITS,...limits});
    if (Object.values(this.limits).some(n => !Number.isSafeInteger(n) || n < 1)) throw Error('invalid capacity limits');
    journal.checkLock();
    if (journal.rows.some(row => row.kind !== 'batch-candidate-v1')) throw Error('incompatible journal');
    this.journal = journal;
    this.validate();
  }
  validate() {
    this.journal.checkLock();
    const receiptIds=new Set(), receiptKeys=new Set();
    for (const receipt of this.journal.receipts) {
      if (!receipt || Object.keys(receipt).sort().join(',')!=='digest,id,key,session,state' || !['accepted','delivered'].includes(receipt.state) || !/^[a-f0-9]{64}$/.test(receipt.key) || !/^[a-f0-9]{64}$/.test(receipt.digest) || typeof receipt.id!=='string' || !validSession(receipt.session) || receiptIds.has(receipt.id) || receiptKeys.has(receipt.key)) throw Error('invalid ingress receipts');
      receiptIds.add(receipt.id); receiptKeys.add(receipt.key);
    }
    const ids = new Set();
    for (const row of this.journal.rows) {
      if (row.kind !== 'batch-candidate-v1' || row.version !== VERSION || !validSession(row.session) || typeof row.id !== 'string' || ids.has(row.id)) throw Error('invalid batch journal');
      ids.add(row.id);
      if (row.type === 'input') {
        if (row.state !== 'accepted' || !Object.hasOwn(row, 'input')) throw Error('invalid batch journal');
      } else if (row.type === 'generation') {
        if (row.state !== 'generation-unknown' || !Array.isArray(row.inputs) || !row.inputs.length || !Array.isArray(row.inputIds) || row.inputIds.length !== row.inputs.length || typeof row.destination !== 'string' || typeof row.generationTag !== 'string') throw Error('invalid batch journal');
      } else if (row.type === 'batch') {
        if (!Array.isArray(row.inputs) || !row.inputs.length || !Array.isArray(row.segments) || !row.segments.length || row.segments.some(s => typeof s !== 'string' || !s.length) || !Number.isInteger(row.index) || row.index < 0 || row.index >= row.segments.length || !['ready','unknown','history-pending'].includes(row.state) || (row.state === 'unknown' && typeof row.attempt !== 'string') || (row.state === 'ready' && row.attempt !== null) || (row.state === 'history-pending' && (row.attempt !== null || row.index !== row.segments.length-1 || !/^[a-f0-9]{64}$/.test(row.ackTag || '')))) throw Error('invalid batch journal');
      } else throw Error('invalid batch journal');
    }
  }
  accept(session, input, capability) {
    this.validate();
    const ingress=ingressCapabilities.get(capability);
    if (capability !== undefined) {
      ingressCapabilities.delete(capability);
      if (!ingress || ingress.queue!==this || ingress.session!==session) throw Error('invalid ingress authorization');
      const receipt=this.journal.receipts.find(r=>r.key===ingress.identity);
      if (receipt) {
        if (receipt.digest!==ingress.digest || receipt.session!==session) { console.error('[durable-chat] message identity conflict; rejected'); throw Error('message identity conflict'); }
        const current=this.journal.rows.find(row=>row.id===receipt.id || row.inputIds?.includes(receipt.id));
        return Object.freeze({id:receipt.id,duplicate:true,state:receipt.state==='delivered' ? 'delivered' : current?.state || 'unknown'});
      }
    }
    if (!validSession(session)) throw Error('session required');
    // Round-trip through JSON now so recovery cannot silently alter a value.
    const encoded = JSON.stringify(input);
    if (encoded === undefined) throw Error('JSON input required');
    if (Buffer.byteLength(session,'utf8') > this.limits.maxSessionBytes || Buffer.byteLength(encoded,'utf8') > this.limits.maxInputBytes) throw Error('capacity exceeded');
    const safe = JSON.parse(encoded);
    const count = rows => rows.reduce((n,r) => n + (r.type === 'input' ? 1 : r.inputs.length),0);
    if (count(this.journal.rows) >= this.limits.maxInputs || count(this.journal.rows.filter(r=>r.session===session)) >= this.limits.maxInputsPerSession) throw Error('capacity exceeded');
    const id = randomUUID();
    const rows=[...this.journal.rows, {kind:'batch-candidate-v1',version:VERSION,type:'input',id,session,state:'accepted',input:safe}];
    const receipts=ingress ? [...this.journal.receipts,{key:ingress.identity,digest:ingress.digest,id,session,state:'accepted'}] : this.journal.receipts;
    if (bytes({rows,receipts}) > this.limits.maxJournalBytes) throw Error('capacity exceeded');
    this.journal.save(rows,receipts);
    return ingress ? Object.freeze({id,duplicate:false,state:'accepted'}) : id;
  }
  form(session, count, segments, capability) {
    this.validate();
    if (!validSession(session) || !Number.isSafeInteger(count) || count < 1 || !Array.isArray(segments) || !segments.length || segments.some(s => typeof s !== 'string' || !s.length)) throw Error('invalid batch');
    if (segments.length > this.limits.maxSegments || segments.some(s=>Buffer.byteLength(s,'utf8') > this.limits.maxSegmentBytes)) throw Error('capacity exceeded');
    const sessionRows = this.journal.rows.filter(r => r.session === session);
    const start = sessionRows.findIndex(r => r.type === 'input');
    const selected = sessionRows.slice(start, start + count);
    if (start < 0 || selected.length !== count || selected.some(r => r.type !== 'input')) throw Error('insufficient consecutive inputs');
    const batch = {kind:'batch-candidate-v1',version:VERSION,type:'batch',id:randomUUID(),session,state:'ready',inputIds:selected.map(r=>r.id),inputs:selected.map(r=>r.input),segments:clone(segments),index:0,attempt:null};
    if (capability !== undefined) {
      const authorization=formationCapabilities.get(capability);
      formationCapabilities.delete(capability);
      if (!authorization || authorization.queue !== this || authorization.session !== session || JSON.stringify(selected) !== authorization.selected || JSON.stringify(segments) !== authorization.segments) throw Error('generation authorization mismatch');
      batch.inputIds=selected.map(r=>r.id);
      batch.destination=authorization.destination;
      batch.outputTags=batch.segments.map((_,i)=>outputTag(authorization.key,batch,i,batch.destination));
      batch.positionTag=positionTag(authorization.key,batch);
    }
    const ids = new Set(selected.map(r=>r.id));
    const rows=[];
    for (const row of this.journal.rows) {
      if (row.id === selected[0].id) rows.push(batch);
      if (!ids.has(row.id)) rows.push(row);
    }
    if (bytes(rows) > this.limits.maxJournalBytes) throw Error('capacity exceeded');
    this.journal.save(rows);
    return clone(batch);
  }
  beginGeneration(session, capability) {
    this.validate();
    const auth=preGenerationCapabilities.get(capability);
    preGenerationCapabilities.delete(capability);
    if (!auth || auth.queue !== this || auth.session !== session) throw Error('generation authorization mismatch');
    const selected=this.journal.rows.filter(r=>r.session===session).slice(0,auth.count);
    if (JSON.stringify(selected)!==auth.selected) throw Error('generation authorization mismatch');
    const row={kind:'batch-candidate-v1',version:VERSION,type:'generation',id:randomUUID(),session,state:'generation-unknown',inputIds:selected.map(r=>r.id),inputs:selected.map(r=>r.input),destination:auth.destination};
    row.generationTag=generationTag(auth.key,row);
    const ids=new Set(row.inputIds), rows=[];
    for (const current of this.journal.rows) { if (current.id===selected[0].id) rows.push(row); if (!ids.has(current.id)) rows.push(current); }
    if (bytes(rows)>this.limits.maxJournalBytes) throw Error('capacity exceeded');
    this.journal.save(rows);
    return clone(row);
  }
  finishGeneration(session, segments, capability) {
    this.validate();
    const auth=preGenerationCapabilities.get(capability);
    preGenerationCapabilities.delete(capability);
    if (!auth || auth.queue!==this || auth.session!==session) throw Error('generation authorization mismatch');
    const first=this.journal.rows.find(r=>r.session===session);
    if (!first || JSON.stringify(first)!==auth.snapshot || first.generationTag!==generationTag(auth.key,first)) throw Error('generation authorization mismatch');
    if (!Array.isArray(segments) || !segments.length || segments.length>this.limits.maxSegments || segments.some(s=>typeof s!=='string' || !s || Buffer.byteLength(s,'utf8')>this.limits.maxSegmentBytes || cleanAllToolArtifacts(s)!==s || /\[CQ:/i.test(s))) throw Error('invalid generated output');
    const batch={kind:first.kind,version:first.version,type:'batch',id:first.id,session,state:'ready',inputIds:first.inputIds,inputs:first.inputs,destination:first.destination,segments:clone(segments),index:0,attempt:null};
    if (auth.history !== undefined) batch.history=historyDependencies(auth.key,batch.destination,auth.history);
    batch.outputTags=batch.segments.map((_,i)=>outputTag(auth.key,batch,i,batch.destination));
    batch.positionTag=positionTag(auth.key,batch);
    const rows=this.journal.rows.map(r=>r.id===first.id ? batch : r);
    if (bytes(rows)>this.limits.maxJournalBytes) throw Error('capacity exceeded');
    this.journal.save(rows);
    return clone(batch);
  }
  claim(session, capability) {
    this.validate();
    if (!validSession(session)) throw Error('session required');
    const first=this.journal.rows.find(r=>r.session===session);
    if (!first || first.type !== 'batch' || first.state !== 'ready') return null;
    const auth=claimCapabilities.get(capability);
    if (capability !== undefined) claimCapabilities.delete(capability);
    if (first.outputTags && (!auth || auth.queue !== this || auth.snapshot !== JSON.stringify(first))) return null;
    const rows=clone(this.journal.rows); const row=rows.find(r=>r.id===first.id);
    row.state='unknown'; row.attempt=randomUUID();
    if (row.outputTags) row.positionTag=positionTag(auth.key,row);
    this.journal.save(rows);
    const claim = Object.freeze({id:row.id, session:row.session, attempt:row.attempt, index:row.index, segment:row.segments[row.index], inputs:clone(row.inputs)});
    this.#claims.set(claim, {id:row.id, session:row.session, attempt:row.attempt, index:row.index});
    return claim;
  }
  complete(claim, outcome, capability) {
    this.validate();
    if (!claim || typeof claim !== 'object' || !this.#claims.has(claim) || !outcome || outcome.status !== 'delivered' || Object.keys(outcome).length !== 1) return false;
    const first=this.journal.rows.find(r=>r.session===claim.session);
    if (!first || first.type !== 'batch' || first.state !== 'unknown' || first.id !== claim.id || first.attempt !== claim.attempt || first.index !== claim.index) return false;
    const auth=completionCapabilities.get(capability);
    if (capability !== undefined) completionCapabilities.delete(capability);
    if (first.outputTags && (!auth || auth.queue !== this || auth.claim !== claim || auth.snapshot !== JSON.stringify(first))) return false;
    const rows=clone(this.journal.rows); const index=rows.findIndex(r=>r.id===first.id); const row=rows[index];
    let receipts=this.journal.receipts;
    if (row.index + 1 === row.segments.length) {
      if (auth?.retainAcknowledged === true) {
        row.state='history-pending'; row.attempt=null;
        row.ackTag=ackTag(auth.key,row);
      } else rows.splice(index,1);
      const done=new Set(row.inputIds || []);
      receipts=receipts.map(r=>done.has(r.id) ? {...r,state:'delivered'} : r);
    } else { row.index++; row.state='ready'; row.attempt=null; if (row.outputTags) row.positionTag=positionTag(auth.key,row); }
    this.journal.save(rows,receipts);
    return true;
  }
  finishHistory(session, capability) {
    this.validate();
    const auth=historyCapabilities.get(capability); historyCapabilities.delete(capability);
    const first=this.journal.rows.find(r=>r.session===session);
    if (!auth || auth.queue!==this || !first || first.state!=='history-pending' || JSON.stringify(first)!==auth.snapshot) throw Error('history authorization mismatch');
    this.journal.save(this.journal.rows.filter(r=>r.id!==first.id));
  }
  list(session) {
    this.validate();
    return clone(this.journal.rows.filter(r=>r.session===session));
  }
}

// Separate opt-in candidate: seal data captured from a particular OneBot parser.
// The operator must separately authenticate and isolate that transport endpoint;
// a parser capability is not proof of upstream identity. No trusted event is recreated.
export function createTransportBoundMessageCandidate({enabled = false, queue, bot, sealKey} = {}) {
  if (enabled !== true) throw Error('transport bound candidate disabled');
  if (!(queue instanceof DurableBatchCandidate) || !Buffer.isBuffer(sealKey) || sealKey.length !== 32 || !bot) throw Error('queue, bot and 32-byte external seal key required');
  const key=Buffer.from(sealKey);
  const keys=['transport','conversation','sender','messageId','text'];
  function normalize(message) {
    if (!message || typeof message !== 'object' || ![Object.prototype,null].includes(Object.getPrototypeOf(message)) || Reflect.ownKeys(message).length !== keys.length) throw Error('invalid message');
    const result={};
    for (const name of keys) {
      const d=Object.getOwnPropertyDescriptor(message,name);
      if (!d || !('value' in d) || typeof d.value !== 'string' || !d.value || Buffer.byteLength(d.value,'utf8') > (name === 'text' ? 32768 : 512)) throw Error('invalid message');
      result[name]=d.value;
    }
    if (result.transport !== 'onebot-qq' || !/^[1-9]\d*$/.test(result.sender) || result.conversation !== `private:${result.sender}` || !/^(?:0|[1-9]\d*|-[1-9]\d*)$/.test(result.messageId)) throw Error('invalid message identity');
    return result;
  }
  const sessionFor = message => `transport-bound-v1:${createHash('sha256').update(JSON.stringify([message.transport,message.conversation])).digest('hex')}`;
  const tagFor = message => createHmac('sha256',key).update('companion-transport-bound-v1\0').update(JSON.stringify(message)).digest();
  return Object.freeze({
    accept(msg) {
      const message=normalize(snapshotOneBotPrivateMessage(bot,msg));
      const transportIdentity=snapshotOneBotDurableIdentity(bot,msg);
      const session=sessionFor(message);
      const identity=createHmac('sha256',queue.journal.key).update('durable-onebot-identity-v1\0').update(JSON.stringify([transportIdentity.instance,transportIdentity.account,message.transport,message.conversation,message.sender,message.messageId])).digest('hex');
      const digest=createHmac('sha256',queue.journal.key).update('durable-onebot-content-v1\0').update(JSON.stringify([message,transportIdentity.content])).digest('hex');
      const capability=Object.freeze({});
      ingressCapabilities.set(capability,{queue,session,identity,digest});
      const result=queue.accept(session,{kind:'transport-bound-v1',message,tag:tagFor(message).toString('hex')},capability);
      return Object.freeze({session,...result});
    },
    reconstruct(session,input) {
      if (!input || typeof input !== 'object' || ![Object.prototype,null].includes(Object.getPrototypeOf(input)) || Reflect.ownKeys(input).sort().join(',') !== 'kind,message,tag') throw Error('invalid bound input');
      const entries=Object.getOwnPropertyDescriptors(input);
      if (!['kind','message','tag'].every(k=>entries[k] && 'value' in entries[k]) || entries.kind.value !== 'transport-bound-v1' || typeof entries.tag.value !== 'string' || !/^[a-f0-9]{64}$/.test(entries.tag.value)) throw Error('invalid bound input');
      const message=normalize(entries.message.value);
      if (session !== sessionFor(message) || !timingSafeEqual(Buffer.from(entries.tag.value,'hex'),tagFor(message))) throw Error('bound message mismatch');
      return Object.freeze(message);
    }
  });
}

// Trusted local composition only: the injected generator is an authority, never
// construct it from chat data. It receives snapshots, not send/tool capabilities.
export function createTrustedBatchGenerationCandidate({enabled=false,queue,bot,sealKey,ownerId,generate}={}) {
  if (enabled !== true) throw Error('trusted generation candidate disabled');
  if (typeof generate !== 'function' || typeof ownerId !== 'string' || !/^[1-9]\d*$/.test(ownerId)) throw Error('trusted generator and owner required');
  const bridge=createTransportBoundMessageCandidate({enabled:true,queue,bot,sealKey});
  const key=Buffer.from(sealKey);
  return Object.freeze({async form(session,count) {
    if (!Number.isSafeInteger(count) || count < 1) throw Error('invalid batch');
    const selected=queue.list(session).slice(0,count);
    if (selected.length !== count || selected.some(r=>r.type !== 'input')) throw Error('insufficient consecutive inputs');
    const messages=selected.map(r=>bridge.reconstruct(session,r.input));
    const destination=messages[0].conversation;
    if (messages.some(m=>m.conversation !== destination || m.sender !== ownerId)) throw Error('destination mismatch');
    const segments=await generate(Object.freeze(messages));
    if (!Array.isArray(segments) || !segments.length || segments.some(s=>typeof s !== 'string' || !s || cleanAllToolArtifacts(s)!==s || /\[CQ:/i.test(s))) throw Error('invalid generated output');
    const snapshot=clone(segments), capability=Object.freeze({});
    formationCapabilities.set(capability,{queue,session,selected:JSON.stringify(selected),segments:JSON.stringify(snapshot),destination,key});
    return queue.form(session,count,snapshot,capability);
  }});
}

// Isolated pre-generation variant: only this closure may reserve and finish.
export function createPreGenerationBatchCandidate({enabled=false,queue,bot,sealKey,ownerId,generate}={}) {
  if (enabled !== true) throw Error('pre-generation candidate disabled');
  if (typeof generate !== 'function' || typeof ownerId !== 'string' || !/^[1-9]\d*$/.test(ownerId)) throw Error('trusted generator and owner required');
  const bridge=createTransportBoundMessageCandidate({enabled:true,queue,bot,sealKey});
  const key=Buffer.from(sealKey);
  return Object.freeze({async form(session,count) {
    if (!Number.isSafeInteger(count) || count<1) throw Error('invalid batch');
    const selected=queue.list(session).slice(0,count);
    if (selected.length!==count || selected.some(r=>r.type!=='input')) throw Error('generation blocked or insufficient consecutive inputs');
    const messages=selected.map(r=>bridge.reconstruct(session,r.input));
    const destination=messages[0].conversation;
    if (messages.some(m=>m.conversation!==destination || m.sender!==ownerId)) throw Error('destination mismatch');
    const begin=Object.freeze({});
    preGenerationCapabilities.set(begin,{queue,session,count,selected:JSON.stringify(selected),destination,key});
    const row=queue.beginGeneration(session,begin);
    const generated=await generate(Object.freeze(messages),Object.freeze({batchId:row.id,batch:JSON.stringify(messages),destination}));
    const segments=Array.isArray(generated) ? generated : generated?.segments;
    const history=Array.isArray(generated) ? undefined : generated?.history;
    if (!Array.isArray(generated) && !Array.isArray(history)) throw Error('history provenance unavailable');
    const finish=Object.freeze({});
    preGenerationCapabilities.set(finish,{queue,session,snapshot:JSON.stringify(row),key,history});
    return queue.finishGeneration(session,segments,finish);
  }});
}

// This closure alone can sign progress after a transport acknowledgement.
// A process with the external seal key or control of the generator is trusted.
export function createBoundBatchProcessorCandidate({enabled=false,queue,bot,sender=bot,sealKey,ownerId,retainAcknowledged=false,requireHistoryProvenance=false}={}) {
  if (enabled !== true) throw Error('bound delivery candidate disabled');
  const bridge=createTransportBoundMessageCandidate({enabled:true,queue,bot,sealKey});
  if (typeof sender?.send !== 'function' || typeof ownerId !== 'string' || !/^[1-9]\d*$/.test(ownerId)) throw Error('OneBot send and owner required');
  const key=Buffer.from(sealKey);
  const lockedSend=Symbol('locked history send');
  const equal=(a,b)=>typeof a==='string' && /^[a-f0-9]{64}$/.test(a) && timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
  function verify(row,session) {
    if (!row || row.type !== 'batch' || row.session !== session || !Array.isArray(row.inputIds) || row.inputIds.length !== row.inputs.length || new Set(row.inputIds).size !== row.inputIds.length || row.inputIds.some(id=>typeof id !== 'string' || !id) || !Array.isArray(row.outputTags) || row.outputTags.length !== row.segments.length) throw Error('unbound batch');
    const messages=row.inputs.map(input=>bridge.reconstruct(session,input));
    if (messages.some(m=>m.conversation !== row.destination || m.sender !== ownerId)) throw Error('destination mismatch');
    if (!safeReplyParts(row.segments)) throw Error('concise blocked');
    if (row.segments.some((s,i)=>cleanAllToolArtifacts(s)!==s || /\[CQ:/i.test(s) || !equal(row.outputTags[i],outputTag(key,row,i,row.destination))) || !equal(row.positionTag,positionTag(key,row))) throw Error('output binding mismatch');
  }
  return Object.freeze({async reserveHistory(session,{store,scope}={}) {
    const row=queue.list(session)[0];
    if (!row || row.state!=='ready') throw Error('batch not ready');
    verify(row,session);
    const messages=row.inputs.map(input=>bridge.reconstruct(session,input));
    if (typeof store?.reserveChatHistory !== 'function' || scope?.session!==row.destination || scope?.user!==ownerId || scope?.platform!=='qq' || scope?.type!=='private') throw Error('history reservation unavailable');
    return store.reserveChatHistory(scope,{turnId:row.id,events:messages.map(m=>`onebot-message:${m.messageId}`),text:messages.map(m=>m.text).join('\n'),reply:row.segments.join('')});
  }, async recordHistory(session,memory,{store,scope}={}) {
    const row=queue.list(session)[0];
    if (!row || row.type!=='batch' || row.state!=='history-pending') throw Error('history not confirmed');
    if (!(memory instanceof Memory) || !equal(row.ackTag,ackTag(key,row))) throw Error('history acknowledgement mismatch');
    const messages=row.inputs.map(input=>bridge.reconstruct(session,input));
    if (!Array.isArray(row.inputIds) || row.inputIds.length!==messages.length || new Set(row.inputIds).size!==messages.length || messages.some(m=>m.conversation!==row.destination || m.sender!==ownerId)) throw Error('history binding mismatch');
    if (!Array.isArray(row.outputTags) || row.outputTags.length!==row.segments.length || row.segments.some((s,i)=>!equal(row.outputTags[i],outputTag(key,row,i,row.destination)))) throw Error('history output mismatch');
    const status=await Memory.prototype.logDurableTurn.call(memory,row.id,{where:row.destination,who:ownerId,text:messages.map(m=>m.text).join('\n'),reply:row.segments.join(''),evidence:messages.map(m=>`onebot-message:${m.messageId}`),store,scope});
    if (!['inserted','duplicate','forgotten'].includes(status)) throw Error('history commit uncertain');
    const capability=Object.freeze({}); historyCapabilities.set(capability,{queue,snapshot:JSON.stringify(row)});
    queue.finishHistory(session,capability);
    return status;
  }, async process(session, history) {
    if (history !== undefined && history !== lockedSend) {
      const {store,scope}=history || {};
      const row=queue.list(session)[0];
      if (!row || row.type!=='batch' || row.state!=='ready') return Object.freeze({status:'blocked'});
      verify(row,session);
      if (!validHistoryDependencies(row.history)) throw Error('generation history provenance unavailable');
      const messages=row.inputs.map(input=>bridge.reconstruct(session,input));
      if (typeof store?.withReservedChatHistorySend !== 'function' || scope?.session!==row.destination || scope?.user!==ownerId || scope?.platform!=='qq' || scope?.type!=='private') throw Error('history reservation unavailable');
      const turn={turnId:row.id,events:messages.map(m=>`onebot-message:${m.messageId}`),text:messages.map(m=>m.text).join('\n'),reply:row.segments.join('')};
      return store.withReservedChatHistorySend(scope,turn,async()=>{
        if (JSON.stringify(queue.list(session)[0])!==JSON.stringify(row)) return Object.freeze({status:'blocked'});
        return this.process(session,lockedSend);
      },row.history,key);
    }
    let row;
    try { row=queue.list(session)[0]; if (!row || row.type !== 'batch' || row.state !== 'ready' || history !== lockedSend || !validHistoryDependencies(row.history)) return Object.freeze({status:'blocked'}); verify(row,session); }
    catch { return Object.freeze({status:'blocked'}); }
    const cap=Object.freeze({}); claimCapabilities.set(cap,{queue,snapshot:JSON.stringify(row),key});
    const claim=queue.claim(session,cap);
    if (!claim) return Object.freeze({status:'blocked'});
    const current=queue.list(session)[0];
    try { verify(current,session); if (current.id!==claim.id || current.attempt!==claim.attempt || current.index!==claim.index || current.segments[current.index]!==claim.segment) throw Error('claim mismatch'); }
    catch { return Object.freeze({status:'unknown'}); }
    let outcome;
    try { outcome=classifyDeliveryCandidate('onebot',await sender.send(current.destination,claim.segment)); }
    catch { return Object.freeze({status:'unknown'}); }
    if (outcome.status==='delivered') {
      const done=Object.freeze({}); completionCapabilities.set(done,{queue,claim,snapshot:JSON.stringify(current),key,retainAcknowledged});
      if (!queue.complete(claim,{status:'delivered'},done)) return Object.freeze({status:'unknown'});
    }
    return outcome;
  }});
}

// Isolated integration only. No replay or production ingress wiring: any existing
// journal requires offline inspection, including accepted-but-unprocessed input.
// The injected OneBot endpoint must be independently authenticated.
export function createDurableOwnerChatQueue({enabled = false, store, bot, sealKey, ownerId, waker, run} = {}) {
  if (enabled !== true) throw Error('durable owner queue disabled');
  if (!(store instanceof DurableBatchCandidate) || !/^[1-9]\d*$/.test(ownerId || '') || typeof run !== 'function' || !waker) throw Error('invalid owner queue configuration');
  store.validate();
  if (store.journal.rows.length) throw Error('existing journal requires offline reconciliation');
  const bridge = createTransportBoundMessageCandidate({enabled:true, queue:store, bot, sealKey});
  const refs = new WeakMap();
  let poisoned = false;
  const queue = new ChatBatchQueue({waker, run:async items => {
    try {
      if (poisoned) throw Error('durable queue unavailable');
      const bound = items.map(item => refs.get(item));
      if (bound.some(x => !x) || bound.some(x => x.session !== bound[0].session)) throw Error('unbound batch');
      const session=bound[0].session;
      const first=store.list(session).slice(0,items.length);
      if (first.length !== items.length || first.some((row,i) => row.type !== 'input' || row.id !== bound[i].id)) throw Error('batch order mismatch');
      // A single marker represents the whole turn, not individual outbound segments.
      store.form(session,items.length,['whole-turn']);
      const claim=store.claim(session);
      if (!claim || claim.inputs.length !== items.length) throw Error('claim unavailable');
      for (let i=0;i<items.length;i++) {
        const message=bridge.reconstruct(session,claim.inputs[i]);
        const live=snapshotOneBotPrivateMessage(bot,items[i]);
        if (JSON.stringify(message)!==JSON.stringify(live) || message.sender !== ownerId) throw Error('message binding changed');
      }
      const result=await run(items);
      if (result?.ok !== true || (result.outcome !== undefined && result.outcome !== 'delivered') || result.partial === true) return {ok:false,outcome:'unknown'};
      if (!store.complete(claim,{status:'delivered'})) throw Error('claim completion failed');
      return {ok:true};
    } catch { poisoned=true; return {ok:false,outcome:'unknown'}; }
  }});
  return Object.freeze({
    add(key,msg,windowMs) {
      if (poisoned || queue.stopped) throw Error('durable queue unavailable');
      const snapshot=snapshotOneBotPrivateMessage(bot,msg);
      if (snapshot.sender !== ownerId || key !== snapshot.conversation) throw Error('owner private message required');
      if (queue.messageCount >= queue.maxMessages || (queue.sessionCounts.get(msg.key) || 0) >= queue.maxMessagesPerSession) return false;
      try {
        const ref=bridge.accept(msg);
        if (ref.duplicate) return true;
        refs.set(msg,ref);
        if (!queue.add(key,msg,windowMs)) throw Error('queue rejected persisted input');
        return true;
      } catch (error) { poisoned=true; throw error; }
    },
    flush:key=>queue.flush(key), stop:()=>queue.stop(), drain:()=>queue.drain(),
  });
}

// Experimental data-only bridge. The injected resolver MUST be a trusted,
// independently authenticated source; this module cannot authenticate it.
// It never creates transport events or grants sender/owner privileges.
export function createBoundMessageCandidate({enabled = false, queue, resolve} = {}) {
  if (enabled !== true) throw Error('bound message bridge disabled');
  if (!(queue instanceof DurableBatchCandidate) || typeof resolve !== 'function') throw Error('trusted queue and resolver required');
  const identity = ['transport','conversation','sender','messageId'];
  function exact(value, keys) {
    if (!value || typeof value !== 'object' || ![Object.prototype,null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== keys.length) throw Error('invalid message');
    for (const key of keys) {
      const d=Object.getOwnPropertyDescriptor(value,key);
      if (!d || !('value' in d) || typeof d.value !== 'string' || !d.value || Buffer.byteLength(d.value,'utf8') > (key === 'text' ? 32768 : 512)) throw Error('invalid message');
    }
    return Object.fromEntries(keys.map(key=>[key,value[key]]));
  }
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const session = ref => { const r=exact(ref,identity); return `bound-v1:${digest([r.transport,r.conversation])}`; };
  async function read(ref) {
    const r=exact(ref,identity);
    const result=exact(await resolve(Object.freeze({...r})),[...identity,'text']);
    if (identity.some(key=>result[key] !== r[key])) throw Error('message identity mismatch');
    return result;
  }
  return Object.freeze({
    session,
    async accept(reference) {
      const ref=exact(reference,identity);
      const message=await read(ref);
      return queue.accept(session(ref),{kind:'bound-message-v1',ref,digest:digest(message)});
    },
    async reconstruct(expectedSession, input) {
      if (!input || typeof input !== 'object' || Reflect.ownKeys(input).sort().join(',') !== 'digest,kind,ref' || input.kind !== 'bound-message-v1' || typeof input.digest !== 'string' || !/^[a-f0-9]{64}$/.test(input.digest)) throw Error('invalid bound input');
      const ref=exact(input.ref,identity);
      if (session(ref) !== expectedSession) throw Error('session mismatch');
      const message=await read(ref);
      if (digest(message) !== input.digest) throw Error('message content mismatch');
      return Object.freeze(message);
    }
  });
}
