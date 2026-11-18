import test from 'node:test';
import assert from 'node:assert/strict';
import { createTiebaReadOnlyCandidate } from '../src/tieba-trusted-session-bridge.js';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import * as login from '../src/tieba-login-integration.js';

const url = 'https://tieba.baidu.com/p/123';

test('unverified official identity evidence never produces an online identity', async () => {
  for (const evidence of [undefined, { state: 'online', subject: 'owner' }, { url: 'https://tieba.baidu.com/', status: 200, body: '{"logged_in":true}' }, { cookie: 'secret' }]) {
    assert.equal(typeof login.verifyOfficialTiebaIdentity, 'function');
    assert.deepEqual(await login.verifyOfficialTiebaIdentity(evidence), { state: 'unknown' });
  }
});

test('partial or redirect-bearing responses are never consumed', async () => {
  for (const response of [
    { status: 206, headers: {}, body: Buffer.from('partial') },
    { status: 200, headers: { location: 'https://evil.invalid/' }, body: Buffer.from('redirect') },
    { status: 200, headers: { 'content-encoding': 'gzip' }, body: Buffer.from('encoded') },
  ]) {
    const c = createTiebaReadOnlyCandidate({ context: { cookies: async () => [] }, resolve4: async () => ['8.8.8.8'], resolve6: async () => [], request: async () => response });
    await assert.rejects(c.fetchBody(url), /response_blocked/);
    await c.close();
  }
});

test('pinned transport passes real response headers into the guard', async () => {
  const original = https.request;
  https.request = (_target, _options, callback) => {
    const req = new EventEmitter();
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = { location: 'https://evil.invalid/' };
      res.destroy = () => {};
      callback(res);
      res.emit('data', Buffer.from('body'));
      res.emit('end');
    };
    return req;
  };
  const c = createTiebaReadOnlyCandidate({ context: { cookies: async () => [] }, resolve4: async () => ['8.8.8.8'], resolve6: async () => [] });
  try { await assert.rejects(c.fetchBody(url), /response_blocked/); }
  finally { await c.close(); https.request = original; }
});
