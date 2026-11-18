import test from 'node:test';
import assert from 'node:assert/strict';
import { createTiebaLoginIntegration } from '../src/tieba-login-integration.js';

test('identity loss during an in-flight read discards result and revokes session', async () => {
  let identity = 'online', closed = 0, entered, release;
  const waiting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const candidate = createTiebaLoginIntegration({
    createSession: async () => ({context: {cookies: async () => []}, close: async () => { closed++; }}),
    verifyIdentity: async () => ({state: identity}),
    listSource: {list: async () => { entered(); await gate; return [{url:'https://tieba.baidu.com/p/123'}]; }},
  });
  assert.equal((await candidate.provider.start()).state, 'online');
  const pending = candidate.source.list({forum:'肥鱼避难所吧'});
  await waiting;
  identity = 'unknown';
  release();
  await assert.rejects(pending, /tieba_candidate_unavailable/);
  assert.equal((await candidate.provider.status()).state, 'unknown');
  assert.equal(closed, 1);
  await candidate.close();
});
