import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startDouyinLiving, browseDouyinLive, watchAndInteractDouyinVideo, stopDouyinLiving } from '../src/douyin-living.js';

test('explicit disable blocks direct chat and direct video before browser launch', async () => {
  const old = chromium.launch; let launches = 0;
  chromium.launch = async () => { launches++; throw Error('no network'); };
  try {
    startDouyinLiving({ enabled: false });
    for (const result of [await browseDouyinLive({ isOwner: true, targetUrl: 'https://www.douyin.com/video/123' }), await watchAndInteractDouyinVideo('https://www.douyin.com/video/123')]) {
      assert.equal(result.success, false);
      assert.match(result.reason, /关闭|禁用/);
    }
    assert.equal(launches, 0);
  } finally { chromium.launch = old; await stopDouyinLiving(); }
});

test('autonomous interaction is a model decision constrained by available permissions', async () => {
  startDouyinLiving({ enabled: true });
  await stopDouyinLiving();
  const { decideDouyinInteraction } = await import('../src/douyin-living.js');
  const brain = { complete: async () => JSON.stringify({ like: true, follow: true }) };
  assert.deepEqual(await decideDouyinInteraction(brain, {title:'公开视频'}, {like: false, follow: true}), {like:false, follow:true});
  assert.deepEqual(await decideDouyinInteraction({complete:async()=>'{bad'}, {}, {like:true, follow:true}), {like:false, follow:false});
});
