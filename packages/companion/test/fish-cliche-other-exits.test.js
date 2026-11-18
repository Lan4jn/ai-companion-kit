import test from 'node:test';
import assert from 'node:assert/strict';
import { startProactive, stopProactive } from '../src/proactive.js';
import { loopGuard } from '../src/loop-guard.js';
import { executePhoneTool } from '../src/phone-tools.js';
import { __debug as bili } from '../src/bili-living.js';
import { postDanmaku } from '../src/bili-grow.js';

test('proactive dad and aunt drafts blocked before any send or state change', async () => {
  const oldSet = globalThis.setTimeout, oldClear = globalThis.clearTimeout;
  const oldFetch = globalThis.fetch;
  let calls = 0, logs = 0;
  globalThis.fetch = async () => { calls++; throw Error('unexpected network'); };
  const timers = [];
  globalThis.setTimeout = fn => { timers.push(fn); return fn; };
  globalThis.clearTimeout = () => {};
  try {
    for (const target of ['dad', 'aunt']) {
      startProactive({ ownerId: 'fish-cliche-test', activeStart: 0, activeEnd: 0, initialDelayMs: 0,
        brain: { reply: async () => ({text: JSON.stringify({want:true,target,text:'这条我认。'})}) },
        memory: { sessionTurns: () => [], logTurn: () => logs++, logDiary: () => logs++ },
        bot: {send: async () => {calls++; return {ok:true};}} });
      await timers.shift()();
      await stopProactive();
      timers.length = 0;
    }
    assert.equal(calls, 0); assert.equal(logs, 0);
    assert.equal(loopGuard.count('private:fish-cliche-test'), 0);
  } finally { await stopProactive(); globalThis.setTimeout = oldSet; globalThis.clearTimeout = oldClear; globalThis.fetch = oldFetch; loopGuard.reset('private:fish-cliche-test'); }
});

test('voice guard runs after cleaning before synthesis', async () => {
  const r = await executePhoneTool('voice_say', {text:'<think>hidden</think>这条我认。'}, {});
  assert.equal(r.status, 'error'); assert.match(r.message, /套话/);
});

test('Bili DM blocks canned output before network, preserves quoted output', async () => {
  const old = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return { json: async () => ({code:0}) }; };
  try {
    const headers = {cookie:'bili_jct=fixture; DedeUserID=123'};
    const blocked = await bili.sendDM('456','这条我认。',headers,{ownerIds:['11111']});
    assert.equal(blocked.code,'fish_cliche'); assert.equal(calls,0);
    const accepted = await bili.sendDM('456','她说“这条我认”，是什么意思？',headers,{ownerIds:['11111']});
    assert.equal(accepted.ok,true); assert.equal(calls,1);
  } finally { globalThis.fetch = old; }
});

test('Bili danmaku blocks canned output before network', async () => {
  const old = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return {json:async () => ({code:0})}; };
  try {
    const args = {cid:1,bvid:'fixture',msg:'这条我认。',headers:{},ownerIds:['11111']};
    assert.equal((await postDanmaku(args)).code,'fish_cliche');
    assert.equal(calls,0);
    assert.equal((await postDanmaku({...args,msg:'“这条我认”是什么意思？'})).ok,true);
    assert.equal(calls,1);
  } finally { globalThis.fetch = old; }
});
