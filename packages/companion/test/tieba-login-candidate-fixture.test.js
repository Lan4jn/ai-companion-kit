import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixtureCandidate, createTiebaCandidate } from '../src/tieba-login-candidate-fixture.js';

test('real Tieba candidate is unconditionally disabled', async () => {
  await assert.rejects(createTiebaCandidate(), /disabled/);
});

test('fixture identity gates persistence, read, and cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tieba-candidate-'));
  let session;
  try {
    session = await createFixtureCandidate({ root, ttlMs: 30000 });
    assert.deepEqual(await readdir(root), []);
    await assert.rejects(session.read(), /not_authenticated/);
    await session.login();
    assert.equal((await readdir(root)).length, 1);
    assert.equal(await session.read(), 'fixture forum content');
    assert.deepEqual(Object.keys(session).sort(), ['close', 'login', 'read']);
    await session.close();
    assert.deepEqual(await readdir(root), []);
  } finally { await session?.close(); await rm(root, { recursive: true, force: true }); }
});

test('failed fixture identity destroys candidate and never persists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tieba-candidate-'));
  let session;
  try {
    session = await createFixtureCandidate({ root, ttlMs: 30000, rejectIdentity: true });
    await assert.rejects(session.login(), /identity/);
    assert.deepEqual(await readdir(root), []);
    await assert.rejects(session.read(), /closed/);
  } finally { await session?.close(); await rm(root, { recursive: true, force: true }); }
});
