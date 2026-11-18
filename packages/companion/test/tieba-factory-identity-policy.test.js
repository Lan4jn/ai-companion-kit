import test from 'node:test';
import assert from 'node:assert/strict';
import { createTiebaCandidateFactory } from '../src/tieba-login-integration.js';

function fixture(initial) {
  let evidence = initial, closed = 0, created = 0;
  const dependencies = {
    openOwnerSession: async () => ({ context: { cookies: async () => [] }, close: async () => { closed++; } }),
    verifyIdentity: async () => evidence,
    listSource: { list: async () => [] },
    createTransport: async () => { created++; return { fetchBody: async () => { throw Error('not_used'); }, close: async () => {} }; },
  };
  return { dependencies, set: value => { evidence = value; }, counts: () => ({ closed, created }) };
}

test('factory is disabled by default and rejects malformed or absent subjects before transport', async () => {
  const f = fixture({ state: 'online', subject: 'fixture' });
  assert.throws(() => createTiebaCandidateFactory(f.dependencies), /unavailable/);
  for (const subject of [undefined, '', ' ', 'a\nb', 'x'.repeat(129), 1]) {
    const x = fixture({ state: 'online', subject });
    const c = createTiebaCandidateFactory({ enabled: true, ...x.dependencies })();
    assert.deepEqual(await c.provider.start(), { state: 'unknown' });
    assert.deepEqual(x.counts(), { closed: 1, created: 0 });
    await c.close();
  }
});

test('factory binds synthetic subject and revokes on disappearance or account switch', async () => {
  for (const next of [{ state: 'online' }, { state: 'online', subject: 'other' }, { state: 'unknown', subject: 'fixture' }]) {
    const f = fixture({ state: 'online', subject: 'fixture' });
    const c = createTiebaCandidateFactory({ enabled: true, ...f.dependencies })();
    assert.deepEqual(await c.provider.start(), { state: 'online' });
    f.set(next);
    assert.deepEqual(await c.provider.status(), { state: 'unknown' });
    assert.equal(f.counts().closed, 1);
    await assert.rejects(c.source.list({ forum: 'test' }), /unavailable/);
    await c.close();
  }
});
