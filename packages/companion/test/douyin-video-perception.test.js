import test from 'node:test';
import assert from 'node:assert/strict';
import { perceiveDouyinVideo, watchAndInteractDouyinVideo } from '../src/douyin-living.js';
import { chromium } from 'playwright-core';

test('视频帧被视觉模型读取并附带实际播放范围，不声称完整观看', async () => {
  let time = 1;
  const page = {
    evaluate: async () => ({ playing: true, currentTime: time, duration: 20 }),
    locator: () => ({ first: () => ({ screenshot: async () => Buffer.from('image') }) }),
    waitForTimeout: async () => { time += 2; },
  };
  const brain = { describeImage: async () => '一只猫跳上桌子' };
  const result = await perceiveDouyinVideo(page, brain);
  assert.equal(result.success, true);
  assert.equal(result.frames.length, 3);
  assert.deepEqual(result.frames.map(f => f.time), [1, 3, 5]);
  assert.equal(result.duration, 20);
  assert.equal(result.complete, false);
  assert.match(result.frames[0].description, /猫/);
});

 test('真实入口视觉不可用时不互动、不声称观看成功', async () => {
  const original = chromium.launch;
  let clicks = 0;
  const page = { url: () => 'https://www.douyin.com/video/123', goto: async () => {}, waitForTimeout: async () => {}, waitForFunction: async () => {}, screenshot: async () => { throw Error(); }, evaluate: async fn => {
    const s = String(fn);
    if (s.includes('loginPanel:')) return {};
    if (s.includes('titleFromBox')) return { title: '标题', author: '作者', topComments: [] };
    if (s.includes('Number.isFinite(video.duration)')) return true;
    if (s.includes("video-player-digg") && s.includes('.click()')) clicks++;
  } };
  chromium.launch = async () => ({ newContext: async () => ({ routeWebSocket: async () => {}, route: async () => {}, newPage: async () => page }), close: async () => {} });
  try {
    const result = await watchAndInteractDouyinVideo('https://www.douyin.com/video/123', { doLike: false, doFollow: false });
    assert.equal(result.success, false);
    assert.match(result.reason, /视觉模型/);
    assert.equal(clicks, 0);
  } finally { chromium.launch = original; }
});

test('视觉服务返回空时明确失败', async () => {
  let time = 1;
  const page = { evaluate: async () => ({ playing: true, currentTime: time, duration: 20 }), locator: () => ({ first: () => ({ screenshot: async () => Buffer.from('x') }) }), waitForTimeout: async () => { time += 2; } };
  const result = await perceiveDouyinVideo(page, { describeImage: async () => null });
  assert.equal(result.success, false);
  assert.match(result.reason, /视觉模型/);
});

test('播放进度不变时拒绝伪造连续画面', async () => {
  const page = { evaluate: async () => ({ playing: true, currentTime: 1, duration: 20 }), locator: () => ({ first: () => ({ screenshot: async () => Buffer.from('x') }) }), waitForTimeout: async () => {} };
  const result = await perceiveDouyinVideo(page, { describeImage: async () => 'x' });
  assert.equal(result.success, false);
  assert.match(result.reason, /连续播放/);
});
