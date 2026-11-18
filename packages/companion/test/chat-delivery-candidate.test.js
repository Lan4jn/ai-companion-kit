import test from 'node:test';
import assert from 'node:assert/strict';
import { DurableBatchCandidate } from '../src/chat-durable-batch-candidate.js';
import { createDeliveryCandidate, classifyDeliveryCandidate } from '../src/chat-delivery-candidate.js';

function queue() {
 const journal={rows:[],receipts:[],checkLock(){},save(rows,receipts=this.receipts){this.rows=structuredClone(rows);this.receipts=structuredClone(receipts)}};
 const q=new DurableBatchCandidate(journal); q.accept('s',{id:'synthetic'}); q.form('s',1,['one','two']); return q;
}
test('OneBot explicit acknowledgement advances exactly one claimed segment', async () => {
 const q=queue(); let sent=[];
 const bridge=createDeliveryCandidate({enabled:true,queue:q,transport:'onebot',send:async (session,text)=>{sent.push([session,text]); return {ok:true,data:{status:'ok',retcode:0}}}});
 assert.equal((await bridge.process('s')).status,'delivered');
 assert.deepEqual(sent,[['s','one']]); assert.equal(q.list('s')[0].index,1);
});
test('ambiguous result is retained and never automatically resent', async () => {
 const q=queue(); let calls=0;
 const bridge=createDeliveryCandidate({enabled:true,queue:q,transport:'onebot',send:async()=>{calls++; throw Error('timeout')}});
 assert.equal((await bridge.process('s')).status,'unknown');
 assert.equal((await bridge.process('s')).status,'blocked'); assert.equal(calls,1); assert.equal(q.list('s')[0].state,'unknown');
});
test('OneBot transformation of claimed text cannot be counted as delivery', async () => {
 const journal={rows:[],receipts:[],checkLock(){},save(rows,receipts=this.receipts){this.rows=structuredClone(rows);this.receipts=structuredClone(receipts)}};
 const q=new DurableBatchCandidate(journal); q.accept('s',{}); q.form('s',1,['abc<think>hidden</think>def']);
 let calls=0; const bridge=createDeliveryCandidate({enabled:true,queue:q,transport:'onebot',send:async()=>{calls++;return {ok:true,data:{status:'ok',retcode:0}}}});
 assert.equal((await bridge.process('s')).status,'permanent'); assert.equal(calls,0); assert.equal(q.list('s')[0].state,'unknown');
});
test('classifier is conservative for legacy, partial and conflicting results',()=>{
 for(const [transport,result] of [
 ['onebot',{ok:true}], ['wechat',{ok:true}], ['onebot',{ok:true,blocked:true,data:{status:'ok',retcode:0}}],
 ['onebot',{ok:true,partial:true,data:{status:'ok',retcode:0}}], ['onebot',{ok:true,outcome:'unknown',data:{status:'ok',retcode:0}}],
 ]) assert.notEqual(classifyDeliveryCandidate(transport,result).status,'delivered');
});
