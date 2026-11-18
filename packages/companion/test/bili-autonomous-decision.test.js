import test from 'node:test';
import assert from 'node:assert/strict';
import { startBiliLiving, stopBiliLiving } from '../src/bili-living.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function run(answer) {
  let calls = 0, watches = 0, prompt;
  const brain = { complete: async options => { calls++; prompt = options.prompt; return answer; } };
  const oldRandom = Math.random;
  Math.random = () => 0;
  try {
    startBiliLiving({ brain, memory: { recentDiary: () => [{activity:'测试生活记录'}] }, skipChance: 0, initialDelayMs: 0,
      backgroundWork: async () => { watches++; return {played:false}; } });
    await wait(80);
    await stopBiliLiving();
    return { calls, watches, prompt };
  } finally { Math.random = oldRandom; await stopBiliLiving(); }
}

test('scheduler asks model with real context and respects explicit refusal', async () => {
  const r = await run('{"want":false}');
  assert.equal(r.calls, 1);
  assert.equal(r.watches, 0);
  assert.doesNotMatch(r.prompt, /测试生活记录/);
  assert.match(r.prompt, /todayPlaybackCount/);
});

test('shutdown cancels an in-flight decision without watching', async () => {
  let watches = 0, calls = 0, signal;
  startBiliLiving({ skipChance: 0, initialDelayMs: 0, brain: { complete: o => { calls++; signal = o.signal; return new Promise(() => {}); } },
    backgroundWork: async () => { watches++; } });
  try {
    await wait(80);
    assert.equal(calls, 1);
    await stopBiliLiving();
    assert.equal(signal.aborted, true);
    assert.equal(watches, 0);
  } finally { await stopBiliLiving(); }
});

test('scheduler watches only on explicit model consent', async () => {
  const yes = await run('{"want":true}');
  assert.equal(yes.calls, 1);
  assert.equal(yes.watches, 1);
  const invalid = await run('not json');
  assert.equal(invalid.calls, 1);
  assert.equal(invalid.watches, 0);
});
