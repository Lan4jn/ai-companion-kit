import test from 'node:test';
import assert from 'node:assert/strict';
import { Waker } from '../src/wake.js';
import { ChatBatchQueue } from '../src/chat-batch-queue.js';

test('confirmed unsent is discarded and later turns proceed in order without retry', async () => {
  const calls=[]; const q=new ChatBatchQueue({waker:new Waker(),run:async items=>{calls.push(items[0].text); return calls.length===1 ? {ok:false,outcome:'permanent',sent:0} : {ok:true};}});
  for (const text of ['first','second','third']) { q.add('p',{key:'p',userId:'u',text},60000); q.flush('p'); }
  await q.drain(); assert.deepEqual(calls,['first','second','third']); assert.equal(q.undelivered.length,0); q.stop();
});

test('capacity is reclaimed after confirmed reconciliation and successful work', async () => {
  let n=0; const q=new ChatBatchQueue({waker:new Waker(),maxMessages:2,run:async()=>++n===1?{ok:false}:{ok:true}});
  q.add('p',{key:'p',userId:'u',text:'a'},60000); q.flush('p'); await assert.rejects(q.drain());
  q.add('p',{key:'p',userId:'u',text:'b'},60000); q.flush('p'); await assert.rejects(q.drain());
  assert.equal(q.add('p',{key:'p',userId:'u',text:'c'},60000),false);
  assert.equal(await q.resolveFailure('p','delivered'),true); await q.drain(); assert.equal(q.messageCount,0);
  assert.equal(q.add('p',{key:'p',userId:'u',text:'d'},60000),true); q.stop(); await q.drain(); assert.equal(q.messageCount,0);
});

test('unknown blocks and bounded capacity rejects extra batches without leaking content', async () => {
  const calls=[]; const q=new ChatBatchQueue({waker:new Waker(),maxMessages:1,run:async items=>{calls.push(items[0].text);return {ok:false,outcome:'unknown'};}});
  q.add('p',{key:'p',userId:'u',text:'secret1'},60000); q.flush('p'); await assert.rejects(q.drain());
  assert.equal(q.add('p',{key:'p',userId:'u',text:'secret2'},60000),false);
  assert.deepEqual(calls,['secret1']); assert.equal(q.undelivered.length,1); q.stop();
});
