import test from 'node:test';
import assert from 'node:assert/strict';
import { createTiebaLoginIntegration } from '../src/tieba-login-integration.js';

test('synthetic verifier: a changed account subject revokes the same-session candidate', async () => {
  let subject = 'fixture-account-one', closed = 0;
  const c = createTiebaLoginIntegration({
    createSession: async () => ({ context: { cookies: async () => [] }, close: async () => { closed++; } }),
    verifyIdentity: async () => ({ state: 'online', subject }),
    listSource: { list: async () => [] },
  });
  assert.deepEqual(await c.provider.start(), { state: 'online' });
  subject = 'fixture-account-two';
  assert.deepEqual(await c.provider.status(), { state: 'unknown' });
  assert.equal(closed, 1);
  await assert.rejects(c.source.list({forum:'肥鱼避难所吧'}), /tieba_candidate_unavailable/);
  await c.close();
});
