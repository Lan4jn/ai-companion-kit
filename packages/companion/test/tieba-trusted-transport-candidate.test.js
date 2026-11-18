import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { createTiebaReadOnlyCandidate } from '../src/tieba-trusted-session-bridge.js';

const context = { cookies: async () => [{ name: 'session', value: 'secret', domain: 'tieba.baidu.com', path: '/', secure: true }] };
const base = { context, resolve4: async () => ['8.8.8.8'], resolve6: async () => [] };
const url = 'https://tieba.baidu.com/p/123';

test('candidate requests a pinned public address and exposes no cookies or response body', async () => {
  const calls = [];
  const candidate = createTiebaReadOnlyCandidate({ ...base, request: async options => { calls.push(options); return { status: 200, body: Buffer.from('private') }; } });
  assert.deepEqual(await candidate.read(url), { status: 200, bytes: 7, identity: 'unknown' });
  assert.equal(calls[0].ip, '8.8.8.8');
  assert.equal(calls[0].headers.cookie, 'session=secret');
  await candidate.close();
  await assert.rejects(candidate.read(url), /closed/);
});

test('unsafe destinations methods and mixed DNS never reach transport or cookies', async () => {
  let hits = 0;
  const c = createTiebaReadOnlyCandidate({ ...base, context: { cookies: async () => { hits++; return []; } }, resolve4: async () => ['8.8.8.8', '127.0.0.1'], request: async () => { hits++; } });
  for (const target of ['https://tieba.baidu.com/p/123?x=1', 'https://tieba.baidu.com/f', 'https://tieba.baidu.com.evil/p/123', 'http://tieba.baidu.com/p/123']) await assert.rejects(c.read(target), /blocked/);
  await assert.rejects(c.read(url, { method: 'POST' }), /blocked/);
  await assert.rejects(c.read(url), /unsafe_dns/);
  assert.equal(hits, 0);
  await c.close();
});

test('real transport pins lookup and refuses redirects without following', async () => {
  const original = https.request; let count = 0;
  https.request = (target, opts, cb) => {
    count++;
    assert.equal(target, url); assert.equal(opts.agent, false); assert.equal(opts.method, 'GET');
    opts.lookup('tieba.baidu.com', {}, (err, ip, family) => { assert.equal(err, null); assert.equal(ip, '8.8.8.8'); assert.equal(family, 4); });
    const req = new EventEmitter();
    req.end = () => { const res = new EventEmitter(); res.statusCode = 302; res.destroy = () => {}; cb(res); };
    return req;
  };
  try { const c = createTiebaReadOnlyCandidate(base); await assert.rejects(c.read(url), /response_blocked/); await c.close(); assert.equal(count, 1); }
  finally { https.request = original; }
});

test('close cancels in-flight work and errors never expose secret messages', async () => {
  const c = createTiebaReadOnlyCandidate({ ...base, resolve4: () => new Promise(() => {}) });
  const task = c.read(url); await c.close(); await assert.rejects(task, /cancelled/);
  const d = createTiebaReadOnlyCandidate({ ...base, context: { cookies: async () => { throw new Error('secret'); } } });
  await assert.rejects(d.read(url), error => error.message === 'tieba_candidate_failed'); await d.close();
});
