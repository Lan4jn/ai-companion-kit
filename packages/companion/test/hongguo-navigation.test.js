import test from 'node:test';
import assert from 'node:assert/strict';
import { navigateHongguo } from '../src/hongguo-navigation.js';

test('模型可以选择跳过且不触碰设备', async () => {
  let touched = false;
  const result = await navigateHongguo({ permission: true, choose: async () => null, observe: async () => { touched = true; }, tap: async () => {}, playback: async () => {} });
  assert.equal(result.status, 'skipped');
  assert.equal(touched, false);
});

const candidate = { resourceId: 'com.example.drama:id/card', title: '作品甲', episodeId: 'ep1', bounds: '[10,20][50,60]', clickable: true, enabled: true };
const snapshot = () => ({ foreground: true, blocked: false, items: [{ ...candidate }] });
const trusted = [{ resourceId: candidate.resourceId, title: candidate.title, episodeId: candidate.episodeId }];
function fixture(overrides = {}) {
  let calls = 0; const taps = [];
  return { taps, options: { permission: true, trusted, choose: async ({ stage }) => stage === 'want' ? true : 0,
    observe: async () => { calls++; return snapshot(); },
    tap: async item => { taps.push(item); return { dispatched: true, revalidated: true }; },
    playback: async () => ({ state: 'playing', episodeId: 'ep1', positionMs: 100 }), ...overrides }, get calls() { return calls; } };
}

test('已知可见作品两次一致后点击并核验同一集播放', async () => {
  const f = fixture();
  assert.deepEqual(await navigateHongguo(f.options), { status: 'verified', episodeId: 'ep1' });
  assert.equal(f.calls, 2);
  assert.equal(f.taps.length, 1);
});

test('未授权、不认识、重复、变化或危险界面均不点击', async () => {
  for (const overrides of [
    { permission: false }, { trusted: [] },
    { observe: async () => ({ ...snapshot(), blocked: true }) },
    { observe: async () => ({ ...snapshot(), items: [candidate, candidate] }) },
    { observe: (() => { let n = 0; return async () => ({ ...snapshot(), items: [{ ...candidate, bounds: ++n === 1 ? candidate.bounds : '[11,20][50,60]' }] }); })() },
  ]) {
    const f = fixture(overrides);
    assert.notEqual((await navigateHongguo(f.options)).status, 'verified');
    assert.equal(f.taps.length, 0);
  }
});

test('点击不等于成功，必须读取同一作品的播放证据', async () => {
  for (const playback of [async () => ({ state: 'playing', episodeId: 'other', positionMs: 1 }), async () => null, async () => { throw Error('private'); }]) {
    const f = fixture({ playback });
    const result = await navigateHongguo(f.options);
    assert.equal(f.taps.length, 1);
    assert.notEqual(result.status, 'verified');
    assert.ok(!JSON.stringify(result).includes('private'));
  }
});
