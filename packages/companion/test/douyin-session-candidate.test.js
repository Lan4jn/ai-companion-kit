import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDouyinSessionCandidate } from '../src/douyin-session-candidate.js';

function fixture(overrides = {}) {
  const calls = [];
  const broker = {
    async verify() { calls.push('verify'); return { state: 'online', cookie: 'SYNTHETIC_SECRET' }; },
    async watch(id) { calls.push(`watch:${id}`); return { state: 'complete', workId: id, cookie: 'SYNTHETIC_SECRET' }; },
    async close() { calls.push('close'); }, ...overrides,
  };
  return { calls, session: createDouyinSessionCandidate({ broker }) };
}
test('requires verification, checks work identity, never returns broker secrets', async () => {
  const { session, calls } = fixture();
  assert.deepEqual(await session.watch('123'), { ok: false, reason: 'unavailable' });
  assert.deepEqual(await session.verify(), { ok: true });
  assert.deepEqual(await session.watch('https://attacker.invalid/'), { ok: false, reason: 'invalid_work' });
  assert.deepEqual(await session.watch('123'), { ok: true, workId: '123' });
  await session.close(); await session.close();
  assert.deepEqual(calls, ['verify', 'watch:123', 'close']);
});
test('unknown or risk login cannot watch or retry', async () => {
  for (const status of ['unknown', 'offline', 'risk']) {
    const { session, calls } = fixture({ verify: async () => ({ state: status }) });
    assert.equal((await session.verify()).ok, false);
    assert.equal((await session.watch('123')).ok, false);
    assert.equal((await session.verify()).ok, false);
    assert.deepEqual(calls, ['close']);
  }
});
test('risk/challenge stops subsequent work and closes broker', async () => {
  for (const status of ['risk', 'challenge']) {
    let count = 0;
    const { session, calls } = fixture({ watch: async () => { count++; return {state:status}; } });
    await session.verify();
    assert.deepEqual(await session.watch('123'), {ok:false,reason:'risk'});
    assert.equal((await session.watch('123')).ok, false);
    assert.equal(count, 1);
    assert.deepEqual(calls, ['verify', 'close']);
  }
});
test('mismatched or partial playback is not success', async () => {
  for (const result of [{state:'complete',workId:'456'}, {state:'partial',workId:'123'}]) {
    const {session} = fixture({watch: async () => result});
    await session.verify();
    assert.deepEqual(await session.watch('123'), {ok:false,reason:'unconfirmed'});
    await session.close();
  }
});
test('cancel invalidates pending verification and serializes access', async () => {
  let release;
  const { session, calls } = fixture({verify: () => new Promise(r => { release = r; })});
  const pending = session.verify();
  assert.equal((await session.verify()).ok, false);
  await session.close();
  release({state:'online'});
  assert.deepEqual(await pending, {ok:false,reason:'cancelled'});
  assert.equal(session.status(), 'closed');
  assert.deepEqual(calls, ['close']);
});
test('broker errors are sanitized and fail closed', async () => {
  const {session, calls} = fixture({watch: async () => {throw Error('SYNTHETIC_SECRET');}});
  await session.verify();
  assert.deepEqual(await session.watch('123'), {ok:false,reason:'unavailable'});
  assert.equal((await session.watch('123')).ok, false);
  assert.deepEqual(calls, ['verify','close']);
});
