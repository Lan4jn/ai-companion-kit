import test from 'node:test';
import assert from 'node:assert/strict';
import { createOwnerTiebaSessionFactory } from '../src/tieba-login-integration.js';

test('owner session factory requires explicit opt-in and closes on expiry', async () => {
  assert.throws(() => createOwnerTiebaSessionFactory({}), /tieba_candidate_unavailable/);
  let closes = 0;
  const context = { cookies: async () => [] };
  const factory = createOwnerTiebaSessionFactory({ enabled: true, ttlMs: 25,
    openOwnerSession: async () => ({ context, close: async () => { closes++; } }) });
  const s = await factory();
  assert.equal(s.context, context);
  await new Promise(r => setTimeout(r, 60));
  assert.equal(closes, 1);
  await s.close(); assert.equal(closes, 1);
});
