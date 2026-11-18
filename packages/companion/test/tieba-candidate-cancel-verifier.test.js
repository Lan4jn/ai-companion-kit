import test from 'node:test';
import assert from 'node:assert/strict';
import { createTiebaLoginIntegration } from '../src/tieba-login-integration.js';

test('cancelling during a stalled identity check closes the session without waiting for verifier', async () => {
  let entered, closed = 0;
  const ready = new Promise(resolve => { entered = resolve; });
  const candidate = createTiebaLoginIntegration({
    createSession: async () => ({ context: { cookies: async () => [] }, close: async () => { closed++; } }),
    verifyIdentity: async () => { entered(); return new Promise(() => {}); },
    listSource: { list: async () => [] },
    createTransport: async () => { throw Error('must not create transport'); },
  });
  const starting = candidate.provider.start();
  await ready;
  const result = await Promise.race([
    candidate.provider.cancel().then(() => 'cancelled'),
    new Promise(resolve => setTimeout(() => resolve('timeout'), 100)),
  ]);
  assert.equal(result, 'cancelled');
  assert.deepEqual(await starting, { state: 'unknown' });
  assert.equal(closed, 1);
  await candidate.close();
});
