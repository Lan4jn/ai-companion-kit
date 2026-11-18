import test from 'node:test';
import assert from 'node:assert/strict';
import { createTiebaReadOnlyCandidate } from '../src/tieba-trusted-session-bridge.js';

const options = { context: { cookies: async () => [] }, resolve4: async () => ['8.8.8.8'], resolve6: async () => [] };
test('candidate rejects oversized responses even from an injected transport', async () => {
  const c = createTiebaReadOnlyCandidate({ ...options, request: async () => ({ status: 200, body: Buffer.alloc(8 * 1024 * 1024 + 1) }) });
  try { await assert.rejects(c.read('https://tieba.baidu.com/p/123'), /response_too_large/); } finally { await c.close(); }
});
