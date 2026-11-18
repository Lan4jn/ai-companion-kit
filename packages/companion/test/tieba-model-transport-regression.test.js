import test from 'node:test';
import assert from 'node:assert/strict';
import { Brain } from '../src/brain.js';
import { createTiebaScheduler } from '../src/tieba-scheduler.js';
import { createTiebaReader } from '../src/tieba-reader.js';

test('tieba decisions reserve enough output tokens for reasoning', async () => {
  const requests = [];
  const brain = { complete: async p => { requests.push(p); return requests.length === 1 ? '{"browse":true}' : '{"action":"stop","record":false,"keywords":[]}'; } };
  const url = 'https://tieba.baidu.com/p/123';
  const reader = createTiebaReader({ enabled:true, dir:process.env.TMPDIR, brain, source:{list:async()=>[{url}],read:async()=>({url,forum:'肥鱼避难所吧',title:'测试',body:'合成内容'})} });
  const scheduler = createTiebaScheduler({enabled:true,brain,reader});
  assert.equal((await scheduler.tick()).status, 'completed');
  assert.ok(requests.every(r => r.max_tokens >= 2000));
});

test('Brain.complete never logs provider response bodies or thrown messages', async () => {
  const oldFetch=globalThis.fetch, oldError=console.error, logs=[];
  console.error=(...args)=>logs.push(args.join(' '));
  const brain=new Brain({apiKey:'fake',baseUrl:'http://invalid.local',model:'test',role:{},memory:{}});
  try {
    globalThis.fetch=async()=>({ok:false,status:500,text:async()=> 'PRIVATE_SECRET_SENTINEL'});
    assert.equal(await brain.complete({prompt:'synthetic'}),null);
    globalThis.fetch=async()=>{throw new Error('PRIVATE_SECRET_SENTINEL');};
    assert.equal(await brain.complete({prompt:'synthetic'}),null);
    assert.doesNotMatch(logs.join('\n'), /PRIVATE_SECRET_SENTINEL/);
  } finally {globalThis.fetch=oldFetch;console.error=oldError;}
});
