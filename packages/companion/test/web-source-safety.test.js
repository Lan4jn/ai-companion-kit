import test from 'node:test';
import assert from 'node:assert/strict';
import { readWebEvidence, isPublicAddress } from '../src/web-evidence.js';
import dns from 'node:dns/promises';
import http from 'node:http';
import { EventEmitter } from 'node:events';

test('rejects internal, mapped, documentation and multicast addresses', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.0.2.1', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1']) assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress('8.8.8.8'), true);
});

test('rejects unsafe URL before network access', async () => {
  for (const url of ['http://127.0.0.1/', 'http://user:pass@example.com/', 'file:///etc/passwd']) await assert.rejects(readWebEvidence(url));
});

test('redirects cannot reach private IPs or private DNS; missing location fails closed', async () => {
  const origLookup = dns.lookup, origGet = http.get;
  let calls = 0;
  try {
    dns.lookup = async host => [{ address: host === 'inside.test' ? '127.0.0.1' : '8.8.8.8', family: 4 }];
    for (const target of ['http://127.0.0.1/', 'http://inside.test/', '']) {
      calls = 0;
      http.get = (_url, _opts, callback) => {
        calls++;
        const req = new EventEmitter();
        queueMicrotask(() => callback(Object.assign(new EventEmitter(), { statusCode: 302, headers: target ? { location: target } : {}, destroy() {} })));
        return req;
      };
      await assert.rejects(readWebEvidence('http://public.test/'), /non-public|invalid or excessive redirect/);
      assert.equal(calls, 1);
    }
  } finally { dns.lookup = origLookup; http.get = origGet; }
});

test('timeout bounds unresolved DNS', async () => {
  const original = dns.lookup;
  try {
    dns.lookup = () => new Promise(() => {});
    const keepAlive = setTimeout(() => {}, 1000);
    try { await assert.rejects(readWebEvidence('http://public.test/', { timeoutMs: 20 }), /timeout/); }
    finally { clearTimeout(keepAlive); }
  } finally { dns.lookup = original; }
});
