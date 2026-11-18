import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cookieHeaderForTieba, createTrustedTiebaBridge } from '../src/tieba-trusted-session-bridge.js';

test('only secure host-only Tieba cookies are eligible', () => {
  const cookies = [
    { name: 'session', value: 'abc', domain: 'tieba.baidu.com', path: '/', secure: true },
    { name: 'parent', value: 'x', domain: '.baidu.com', path: '/', secure: true },
    { name: 'other', value: 'x', domain: 'passport.baidu.com', path: '/', secure: true },
    { name: 'insecure', value: 'x', domain: 'tieba.baidu.com', path: '/', secure: false },
  ];
  assert.equal(cookieHeaderForTieba('https://tieba.baidu.com/p/123', cookies), 'session=abc');
  assert.equal(cookieHeaderForTieba('https://tb3.bdstatic.com/tb/pc/a.js', cookies), '');
});

test('production bridge stays disabled without verified identity and provenance', () => {
  assert.throws(() => createTrustedTiebaBridge(), /tieba_trusted_bridge_unavailable/);
});

test('cookie paths, expiry and invalid syntax fail closed', () => {
  const base = { domain: 'tieba.baidu.com', secure: true, path: '/p', name: 's', value: 'ok' };
  assert.equal(cookieHeaderForTieba('https://tieba.baidu.com/p/123', [base], 2000), 's=ok');
  assert.equal(cookieHeaderForTieba('https://tieba.baidu.com/prefix', [base], 2000), '');
  assert.equal(cookieHeaderForTieba('https://tieba.baidu.com/p', [{ ...base, expires: 2 }], 2000), '');
  assert.equal(cookieHeaderForTieba('https://tieba.baidu.com/p', [{ ...base, value: 'x; injected=y' }]), '');
  assert.equal(cookieHeaderForTieba('https://tieba.baidu.com.evil.test/p', [base]), '');
});
