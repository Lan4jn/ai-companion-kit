import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createGoalCore } from '../src/goal-core.js';
import { startWebLiving, stopWebLiving, browseWebTopic } from '../src/web-living.js';

test('web stop waits for a pending scheduled decision and blocks browsing', async () => {
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout, OriginalDate = globalThis.Date;
  const timers = []; let release, calls = 0, entered;
  const modelEntered = new Promise(resolve => { entered = resolve; });
  const originalFetch = globalThis.fetch; let fetches = 0;
  globalThis.fetch = async () => { fetches++; throw new Error('unexpected network'); };
  globalThis.setTimeout = (fn, ms) => { timers.push({fn, ms}); return timers.length; };
  globalThis.clearTimeout = () => {};
  globalThis.Date = class extends OriginalDate { constructor(...args) { super(...(args.length ? args : ['2025-01-01T12:00:00'])); } };
  try {
    startWebLiving({brain:{complete:() => {calls++; entered(); return new Promise(r => {release = r;});}}, memory:{dir:process.env.TMPDIR}});
    const task = timers.find(t => t.ms === 20000).fn();
    await modelEntered;
    assert.equal(calls, 1);
    let done = false; const stopped = Promise.resolve(stopWebLiving()).then(() => {done = true;});
    await Promise.resolve(); assert.equal(done, false);
    release({want:true, reason:'test', keyword:'test'});
    await task; await stopped;
    assert.equal(calls, 1);
    assert.equal(fetches, 0);
    assert.equal(done, true);
  } finally { await stopWebLiving(); globalThis.fetch = originalFetch; globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; globalThis.Date = OriginalDate; }
});

test('stopping during a pending trending request starts no further network or model work', async () => {
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout, OriginalDate = globalThis.Date, originalFetch = globalThis.fetch;
  const timers = []; let releaseFetch, notifyFetch, calls = 0, fetches = 0;
  const fetchEntered = new Promise(resolve => { notifyFetch = resolve; });
  globalThis.setTimeout = (fn, ms) => { timers.push({fn, ms}); return timers.length; };
  globalThis.clearTimeout = () => {};
  globalThis.Date = class extends OriginalDate { constructor(...args) { super(...(args.length ? args : ['2025-01-01T12:00:00'])); } };
  globalThis.fetch = () => { fetches++; if (fetches > 1) return Promise.reject(new Error('unexpected extra request')); notifyFetch(); return new Promise(resolve => { releaseFetch = resolve; }); };
  try {
    startWebLiving({brain:{complete:async () => { calls++; return {want:true, reason:'test'}; }}, memory:{dir:process.env.TMPDIR}});
    const task = timers.find(t => t.ms === 20000).fn();
    await fetchEntered;
    let done = false; const stopped = stopWebLiving().then(() => { done = true; });
    await Promise.resolve(); assert.equal(done, false);
    releaseFetch({json:async () => ({data:{realtime:[]}})});
    await task; await stopped;
    assert.equal(fetches, 1);
    assert.equal(calls, 1);
    assert.equal(done, true);
  } finally { await stopWebLiving(); globalThis.fetch = originalFetch; globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; globalThis.Date = OriginalDate; }
});


test('interrupted unknown deep research is not automatically started twice', async t => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'web-stop-unknown-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const topic = '怪物猎人荒野';
  let current = true, release, entered, searches = 0, models = 0;
  const pending = new Promise(resolve => { entered = resolve; });
  const snippet = {success:true, text:`1. ${topic}相关介绍\n(来源: web https://example.com/a)`};
  const search = () => { searches++; if (searches === 1) return Promise.resolve(snippet); entered(); return new Promise(resolve => { release = resolve; }); };
  const brain = {complete:async () => { models++; return {deep:true, why:'测试'}; }};
  const first = browseWebTopic({topic, memory:{dir}, brain, search, isCurrent:() => current});
  await pending;
  current = false;
  release(snippet);
  const result = await first;
  assert.equal(result.goalStatus, 'unknown');
  const core = createGoalCore({file:path.join(dir,'web-goals.json')});
  assert.equal(Object.values(core.snapshot().desires)[0].status, 'active');
  const retried = await browseWebTopic({topic, memory:{dir}, brain, search});
  assert.equal(retried.success, false);
  assert.equal(searches, 2);
  assert.equal(models, 1);
  assert.equal(Object.keys(core.snapshot().desires).length, 1);
});
