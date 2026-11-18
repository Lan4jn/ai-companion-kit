import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Humanizer } from '../src/humanize.js';
import { initGroupBridge, enqueueGroupMessage, startOutboxWorker, getOutboxStatus } from '../src/group-bridge.js';

const settle = () => new Promise(resolve => setTimeout(resolve, 30));

test('failed partial delivery blocks retry and does not duplicate confirmed parts', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bridge-test-'));
  const oldInterval = globalThis.setInterval;
  let tick;
  globalThis.setInterval = fn => { tick = fn; return {}; };
  const calls = [];
  let fail = true;
  const bot = { groupMembers: new Map([['1', []]]), setTyping: async () => {}, send: async (_key, text) => {
    calls.push(text);
    if (text === 'second' && fail) return { ok: false, outcome: 'retry', error: 'offline' };
    return { ok: true };
  } };
  const opts = { bot, human: new Humanizer({ enabled: false }), dataDir: dir, limits: { minGapMs: 0, maxGapMs: 0 } };
  try {
    initGroupBridge(opts);
    enqueueGroupMessage({ groupId: '1', text: 'first\n\nsecond\n\nthird' });
    startOutboxWorker();
    await settle();
    assert.deepEqual(calls, ['first', 'second']);
    assert.equal(getOutboxStatus().pending, 1);
    assert.deepEqual(getOutboxStatus().sentToday, {});
    initGroupBridge(opts);
    assert.equal(getOutboxStatus().pending, 1);
    fail = false;
    startOutboxWorker();
    await settle();
    assert.deepEqual(calls, ['first', 'second']);
    assert.equal(getOutboxStatus().pending, 1);
    assert.equal(getOutboxStatus().deliveryStates.unknown, 1);
    assert.deepEqual(getOutboxStatus().sentToday, {});
  } finally {
    globalThis.setInterval = oldInterval;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('plain group delivery sends separate paragraphs in order', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bridge-test-'));
  const oldInterval = globalThis.setInterval;
  globalThis.setInterval = () => ({});
  const calls = [];
  try {
    initGroupBridge({bot: {groupMembers: new Map([['1', []]]), send: async (_key, text) => { calls.push(text); return {ok:true}; }}, dataDir: dir, limits:{minGapMs:0,maxGapMs:0}});
    enqueueGroupMessage({groupId:'1', text:'first\n\nsecond\n\nthird'});
    startOutboxWorker(); await settle();
    assert.deepEqual(calls, ['first', 'second', 'third']);
    assert.equal(getOutboxStatus().pending, 0);
  } finally { globalThis.setInterval = oldInterval; fs.rmSync(dir, {recursive:true, force:true}); }
});

test('direct failure remains queued and retry succeeds', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bridge-test-'));
  const oldInterval = globalThis.setInterval;
  globalThis.setInterval = () => ({});
  let result = { ok: false, outcome: 'retry', error: 'offline' };
  const bot = { groupMembers: new Map([['1', []]]), send: async () => result };
  const opts = { bot, dataDir: dir, limits: { minGapMs: 0, maxGapMs: 0 } };
  try {
    initGroupBridge(opts);
    enqueueGroupMessage({ groupId: '1', text: 'hello' });
    startOutboxWorker();
    await settle();
    assert.equal(getOutboxStatus().pending, 1);
    assert.deepEqual(getOutboxStatus().sentToday, {});
    result = { ok: true };
    initGroupBridge(opts);
    startOutboxWorker();
    await settle();
    assert.equal(getOutboxStatus().pending, 0);
    assert.equal(getOutboxStatus().sentToday['1'], 1);
  } finally {
    globalThis.setInterval = oldInterval;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('exception after a confirmed part leaves the ambiguous part for review', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bridge-test-'));
  const oldInterval = globalThis.setInterval;
  globalThis.setInterval = () => ({});
  let fail = true;
  const calls = [];
  const bot = { groupMembers: new Map([['1', []]]), send: async (_key, text) => {
    calls.push(text);
    if (text === 'second' && fail) throw new Error('offline');
    return { ok: true };
  } };
  const opts = { bot, human: new Humanizer({ enabled: false }), dataDir: dir, limits: { minGapMs: 0, maxGapMs: 0 } };
  try {
    initGroupBridge(opts);
    enqueueGroupMessage({ groupId: '1', text: 'first\n\nsecond' });
    startOutboxWorker();
    await settle();
    assert.equal(getOutboxStatus().pending, 1);
    assert.deepEqual(getOutboxStatus().sentToday, {});
    fail = false;
    initGroupBridge(opts);
    startOutboxWorker();
    await settle();
    assert.deepEqual(calls, ['first', 'second']);
    assert.equal(getOutboxStatus().pending, 1);
  } finally {
    globalThis.setInterval = oldInterval;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('overlapping ticks cannot send the same item twice', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bridge-test-'));
  const oldInterval = globalThis.setInterval;
  let tick, finish, calls = 0;
  globalThis.setInterval = fn => { tick = fn; return {}; };
  const bot = { groupMembers: new Map([['1', []]]), send: () => { calls++; return new Promise(resolve => { finish = resolve; }); } };
  try {
    initGroupBridge({ bot, dataDir: dir, limits: { minGapMs: 0, maxGapMs: 0 } });
    enqueueGroupMessage({ groupId: '1', text: 'hello' });
    startOutboxWorker();
    tick();
    assert.equal(calls, 1);
    finish({ ok: true });
    await settle();
    assert.equal(getOutboxStatus().pending, 0);
  } finally {
    globalThis.setInterval = oldInterval;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
