import test from 'node:test';
import assert from 'node:assert/strict';
import { Waker } from '../src/wake.js';
import { ChatBatchQueue } from '../src/chat-batch-queue.js';
const msg = (key, n, userId = 'u') => ({key, userId, text:String(n)});

test('sixth message and following batches drain in per-session order', async () => {
  const calls=[]; let release; const gate=new Promise(r=>release=r);
  const queue=new ChatBatchQueue({waker:new Waker(), run:async items=>{calls.push(items.map(x=>x.text)); if(calls.length===1) await gate; return {ok:true};}});
  for(let n=0;n<13;n++) queue.add('p',msg('p',n),60000);
  await new Promise(r=>setImmediate(r)); assert.deepEqual(calls, [['0','1','2','3','4','5']]);
  queue.stop(); assert.equal(queue.add('p',msg('p',13),1),false); release(); await queue.drain();
  assert.deepEqual(calls,[['0','1','2','3','4','5'],['6','7','8','9','10','11'],['12']]);
});

test('users batch separately but same group turns serialize, other sessions progress', async () => {
  const calls=[]; let release; const gate=new Promise(r=>release=r);
  const q=new ChatBatchQueue({waker:new Waker(),run:async items=>{calls.push(items.map(x=>x.userId+':'+x.text)); if(items[0].userId==='a') await gate; return {ok:true};}});
  for(let i=0;i<6;i++) q.add('g:a',msg('g',i,'a'),60000);
  for(let i=0;i<6;i++) q.add('g:b',msg('g',i,'b'),60000);
  for(let i=0;i<6;i++) q.add('other',msg('other',i,'c'),60000);
  await new Promise(r=>setImmediate(r)); assert.equal(calls.length,2); assert.equal(calls[1][0],'c:0');
  q.stop(); release(); await q.drain(); assert.equal(calls[2][0],'b:0'); assert.ok(calls.every(c=>new Set(c.map(v=>v[0])).size===1));
});

test('unknown or failed delivery is never retried and blocks later same-session work', async () => {
  const calls=[]; const q=new ChatBatchQueue({waker:new Waker(),run:async items=>{calls.push(items); return {ok:false};}});
  for(let i=0;i<13;i++) q.add('p',msg('p',i),60000);
  q.stop(); await assert.rejects(q.drain()); assert.equal(calls.length,1);
});

test('thrown send outcome is not retried', async () => {
  let calls=0;
  const q=new ChatBatchQueue({waker:new Waker(),run:async()=>{ calls++; throw new Error('unknown'); }});
  for(let i=0;i<7;i++) q.add('p',msg('p',i),60000);
  q.stop(); await assert.rejects(q.drain()); assert.equal(calls,1);
});

test('timer flushes one partial batch once', async () => {
  const calls=[];
  const q=new ChatBatchQueue({waker:new Waker(),run:async items=>{calls.push(items.map(m=>m.text)); return {ok:true};}});
  q.add('p',msg('p',1),10);
  await new Promise(r=>setTimeout(r,40)); q.stop(); await q.drain();
  assert.deepEqual(calls,[['1']]);
});
