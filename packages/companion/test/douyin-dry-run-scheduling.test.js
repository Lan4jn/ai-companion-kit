import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startDouyinLiving, browseDouyinLive, watchAndInteractDouyinVideo, fetchDouyinFeed, fetchOwnerVideos, generateDouyinComment, submitDouyinComment } from '../src/douyin-living.js';

test('dry run prevents scheduled and direct Douyin network access', async () => {
  const oldLaunch = chromium.launch, oldTimeout = globalThis.setTimeout;
  let launches = 0, timers = 0, roomWrites = 0;
  chromium.launch = async () => { launches++; throw Error('network forbidden'); };
  globalThis.setTimeout = () => { timers++; return 1; };
  try {
    startDouyinLiving({ dryRun: true, room: { setState() { roomWrites++; } } });
    const a = await browseDouyinLive({ targetUrl: 'https://www.douyin.com/video/123456' });
    const b = await watchAndInteractDouyinVideo('https://www.douyin.com/video/123456');
    await fetchDouyinFeed();
    await fetchOwnerVideos('/nonexistent');
    let calls = 0;
    await generateDouyinComment({ reply: async () => { calls++; return { text: 'hello' }; } }, { title: 'test', author: 'test' });
    await submitDouyinComment('hello', ['123456'], async () => { calls++; });
    assert.equal(calls, 0);
    assert.equal(a.success, false);
    assert.equal(b.success, false);
    assert.equal(launches, 0);
    assert.equal(timers, 0);
    assert.equal(roomWrites, 0);
  } finally { chromium.launch = oldLaunch; globalThis.setTimeout = oldTimeout; }
});

test('disabled autonomous scheduler creates no timer but initializes direct-use context', () => {
  const oldTimeout = globalThis.setTimeout;
  let timers = 0;
  globalThis.setTimeout = () => { timers++; return 1; };
  try {
    startDouyinLiving({ enabled: false });
    assert.equal(timers, 0);
    startDouyinLiving({ enabled: true });
    assert.equal(timers, 1);
  } finally { globalThis.setTimeout = oldTimeout; }
});
