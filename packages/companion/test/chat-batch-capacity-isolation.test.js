import test from 'node:test';
import assert from 'node:assert/strict';
import { Waker } from '../src/wake.js';
import { ChatBatchQueue } from '../src/chat-batch-queue.js';

test('a blocked session cannot monopolize global capacity; reconciliation reclaims its quota', async () => {
  const calls=[];
  const q=new ChatBatchQueue({waker:new Waker(),maxMessages:4,maxMessagesPerSession:2,run:async items=>{calls.push(items[0].key);return items[0].key==='private:a'?{ok:false,outcome:'unknown'}:{ok:true};}});
  const add=(session,text)=>{const ok=q.add(session,{key:session,userId:'u',text},60000);if(ok)q.flush(session);return ok;};
  assert.equal(add('private:a','a'),true); await assert.rejects(q.drain());
  assert.equal(add('private:a','b'),true); await assert.rejects(q.drain());
  assert.equal(add('private:a','c'),false);
  assert.equal(add('private:b','d'),true); await assert.rejects(q.drain());
  assert.deepEqual(calls,['private:a','private:b']);
  assert.equal(await q.resolveFailure('private:a','delivered'),true);
  await assert.rejects(q.drain()); // the held second turn is now unknown
  assert.equal(add('private:a','e'),true);
  q.stop(); await assert.rejects(q.drain());
});
