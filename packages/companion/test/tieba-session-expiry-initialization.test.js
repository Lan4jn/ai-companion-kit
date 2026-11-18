import test from 'node:test';
import assert from 'node:assert/strict';
import { createTiebaLoginIntegration } from '../src/tieba-login-integration.js';

test('session expiring while transport initializes cannot become online', async () => {
  let active = true, release, transportClosed = 0, sessionClosed = 0;
  let started;
  const initializing = new Promise(resolve => { started = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const integration = createTiebaLoginIntegration({
    createSession: async () => ({ context: { cookies: async () => [] }, isActive: () => active, close: async () => { sessionClosed++; } }),
    verifyIdentity: async () => ({ state: 'online' }),
    listSource: { list: async () => [] },
    createTransport: async () => { started(); await pending; return { fetchBody: async () => ({}), close: async () => { transportClosed++; } }; },
  });
  const start = integration.provider.start();
  await initializing;
  active = false;
  release();
  assert.deepEqual(await start, { state: 'unknown' });
  assert.equal(transportClosed, 1);
  assert.equal(sessionClosed, 1);
  await integration.close();
});
