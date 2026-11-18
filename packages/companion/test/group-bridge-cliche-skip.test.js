import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initGroupBridge, startOutboxWorker, stopOutboxWorker, getOutboxStatus } from '../src/group-bridge.js';
import { initDevChannel, callAunt, requestFeature, triggerDev } from '../src/dev-channel.js';

const wait = ms => new Promise(r => setTimeout(r, ms));
test('known-unsent cliche is dropped while unknown remains a same-group barrier', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'bridge-skip-'));
  const sent = [];
  const bot = { groupMembers: new Map([['1', []], ['2', []], ['3', []]]), send: async (key, text) => { sent.push([key, text]); return { ok: true }; } };
  try {
    fs.writeFileSync(path.join(dir, 'outbox.json'), JSON.stringify({ pending: [
      { gid: '1', text: '这条我认' }, { gid: '1', text: 'hello' },
      { gid: '2', text: '这条我认', deliveryState: 'unknown' }, { gid: '2', text: 'blocked' },
      { gid: '3', text: 'other' }
    ] }));
    initGroupBridge({ bot, dataDir: dir, limits: { minGapMs: 0, maxGapMs: 0 } });
    for (let i = 0; i < 4; i++) { startOutboxWorker(); await wait(25); await stopOutboxWorker(); }
    assert.deepEqual(sent, [['group:1', 'hello'], ['group:3', 'other']]);
    assert.equal(getOutboxStatus().deliveryStates.unknown, 1);
    assert.equal(getOutboxStatus().pending, 2);
    const disk = JSON.parse(fs.readFileSync(path.join(dir, 'outbox.json')));
    assert.deepEqual(disk.pending.map(x => x.text), ['这条我认', 'blocked']);
  } finally { await stopOutboxWorker(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('split message with a formulaic part does not discard factual remainder', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'bridge-parts-'));
  const sent = [];
  const bot = { groupMembers: new Map([['1', []]]), send: async (key, text) => { sent.push(text); return { ok: true }; }, setTyping: async () => {} };
  const human = { say: async (parts, {send}) => { for (const part of [...parts]) await send(part); return {ok:true}; } };
  try {
    fs.writeFileSync(path.join(dir, 'outbox.json'), JSON.stringify({ pending: [
      { gid: '1', text: '这条我认。价格500元。', parts: ['这条我认。', '价格500元。'], deliveryState: 'retry' }
    ] }));
    initGroupBridge({ bot, human, dataDir: dir, limits: { minGapMs: 0, maxGapMs: 0 } });
    startOutboxWorker(); await wait(40); await stopOutboxWorker();
    assert.deepEqual(sent, ['这条我认。', '价格500元。']);
  } finally { await stopOutboxWorker(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('direct developer messages reject cliches before fetch', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'dev-guard-'));
  const oldFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: true, status: 200, json: async () => ({ reply: 'ok' }) }; };
  try {
    initDevChannel({ dataDir: dir });
    assert.equal((await callAunt({ message: '这条我认' })).status, 'error');
    assert.equal((await callAunt({ message: '你好', situation: '这条我认' })).status, 'error');
    const req = requestFeature({ title: '标题', detail: '这条我认' });
    assert.equal((await triggerDev(req.message.match(/（(.*?)）/)[1])).status, 'error');
    assert.equal(calls, 0);
    assert.equal((await callAunt({ message: '你好' })).status, 'ok');
    assert.equal(calls, 1);
  } finally { globalThis.fetch = oldFetch; fs.rmSync(dir, { recursive: true, force: true }); }
});
