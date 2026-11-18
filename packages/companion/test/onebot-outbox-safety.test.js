import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initGroupBridge, enqueueGroupMessage, startOutboxWorker, getOutboxStatus } from '../src/group-bridge.js';

const wait = () => new Promise(r => setTimeout(r, 25));
const dir = () => fs.mkdtempSync(path.join(process.env.TMPDIR, 'onebot-bridge-'));

test('ambiguous send is persisted and never retried after restart', async () => {
  const d = dir(), old = globalThis.setInterval; let tick, calls = 0;
  globalThis.setInterval = fn => { tick = fn; return {}; };
  const bot = { groupMembers: new Map([['1', []]]), send: async () => { calls++; return { ok: false, outcome: 'unknown', error: 'timeout' }; } };
  const opts = { bot, dataDir: d, limits: { minGapMs: 0, maxGapMs: 0 } };
  try {
    initGroupBridge(opts); enqueueGroupMessage({ groupId: '1', text: 'hi' }); startOutboxWorker(); await wait();
    tick(); await wait(); initGroupBridge(opts); startOutboxWorker(); await wait();
    assert.equal(calls, 1);
    assert.equal(getOutboxStatus().pending, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(d, 'outbox.json'))).pending[0].deliveryState, 'unknown');
  } finally { globalThis.setInterval = old; fs.rmSync(d, { recursive: true, force: true }); }
});

test('permanent failure does not block another group', async () => {
  const d = dir(), old = globalThis.setInterval; let tick; const calls = [];
  globalThis.setInterval = fn => { tick = fn; return {}; };
  const bot = { groupMembers: new Map([['1', []], ['2', []]]), send: async key => {
    calls.push(key); return key === 'group:1' ? { ok: false, outcome: 'permanent' } : { ok: true };
  } };
  try {
    initGroupBridge({ bot, dataDir: d, limits: { minGapMs: 0, maxGapMs: 0 } });
    enqueueGroupMessage({ groupId: '1', text: 'one' }); enqueueGroupMessage({ groupId: '2', text: 'two' });
    startOutboxWorker(); await wait(); tick(); await wait();
    assert.deepEqual(calls, ['group:1', 'group:2']);
    assert.equal(getOutboxStatus().pending, 1);
  } finally { globalThis.setInterval = old; fs.rmSync(d, { recursive: true, force: true }); }
});

test('failed persistence prevents sends', async () => {
  const d = dir(), old = globalThis.setInterval; let calls = 0;
  globalThis.setInterval = () => ({});
  const bot = { groupMembers: new Map([['1', []]]), send: async () => { calls++; return { ok: true }; } };
  try {
    fs.writeFileSync(path.join(d, 'not-a-dir'), 'x');
    initGroupBridge({ bot, dataDir: path.join(d, 'not-a-dir') });
    assert.equal(enqueueGroupMessage({ groupId: '1', text: 'one' }).status, 'error');
    startOutboxWorker(); await wait(); assert.equal(calls, 0);
  } finally { globalThis.setInterval = old; fs.rmSync(d, { recursive: true, force: true }); }
});

test('failed result persistence stops worker and restart treats inflight as unknown', async () => {
  const d = dir(), old = globalThis.setInterval, oldRename = fs.renameSync; let tick, calls = 0, fail = false;
  globalThis.setInterval = fn => { tick = fn; return {}; };
  const bot = { groupMembers: new Map([['1', []]]), send: async () => { calls++; fail = true; return { ok: true }; } };
  const opts = { bot, dataDir: d, limits: { minGapMs: 0, maxGapMs: 0 } };
  try {
    fs.renameSync = (...args) => { if (fail) throw new Error('disk full'); return oldRename(...args); };
    initGroupBridge(opts); enqueueGroupMessage({ groupId: '1', text: 'one' }); startOutboxWorker(); await wait();
    assert.equal(getOutboxStatus().storageFailed, true);
    tick(); await wait(); assert.equal(calls, 1);
    fail = false; fs.renameSync = oldRename;
    initGroupBridge(opts); startOutboxWorker(); await wait();
    assert.equal(calls, 1); assert.equal(getOutboxStatus().deliveryStates.unknown, 1);
  } finally { fs.renameSync = oldRename; globalThis.setInterval = old; fs.rmSync(d, { recursive: true, force: true }); }
});
