import test from 'node:test';
import assert from 'node:assert/strict';
import { browserComment, closeWatchBrowser } from '../src/bili-browser.js';
import { chromium } from 'playwright-core';
import { __debug } from '../src/bili-living.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.BILI_COMMENT_LEDGER_DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bili-natural-'));

test('synthetic public writes block empty cliche before browser or fetch', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: true, json: async () => ({ code: 0 }) }; };
  try {
    for (const r of [await browserComment('synthetic', '我接住了', {}, { ownerIds: ['123456'] }), await __debug.postComment('1', '我接住了', { cookie: 'bili_jct=synthetic' }, { ownerIds: ['123456'] }), await __debug.replyToComment('1', '2', '我接住了', { cookie: 'bili_jct=synthetic' }, { ownerIds: ['123456'] })]) {
      assert.equal(r.ok, false);
      assert.equal(r.code, 'public_comment_cliche');
    }
    assert.equal(calls, 0);
    const quoted = await __debug.replyToComment('1', '2', '你说的“我接住了”是什么意思？', { cookie: 'DedeUserID=789; bili_jct=synthetic' }, { ownerIds: ['123456'] });
    assert.equal(quoted.ok, true);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});


test('synthetic browser submits intact quoted content exactly once', async () => {
  const launch = chromium.launch;
  let typed = '', submits = 0, launches = 0;
  const editor = { first() { return this; }, async waitFor() {}, async click() {}, async innerText() { return submits ? '' : typed; } };
  const button = { first() { return this; }, async waitFor() {}, async evaluate() { return false; }, async click() { submits++; } };
  let ev = 0;
  const page = { async goto() {}, async waitForTimeout() {}, async evaluate() { return ++ev % 3 === 2 ? { aid: 33, bvid: 'synthetic' } : ''; }, locator(s) { return s.startsWith('div') ? editor : button; }, keyboard: { async type(s) { typed = s; } } };
  chromium.launch = async () => { launches++; return { isConnected: () => true, async close() {}, async newContext() { return { async addCookies() {}, async newPage() { return page; }, async close() {} }; } }; };
  try {
    const text = '你说的“我接住了”是什么意思？';
    const result = await browserComment('synthetic', text, {dedeuserid:'789'}, { aid:33, ownerIds: ['123456'], typeDelay: 0 });
    assert.equal(result.ok, false);
    assert.equal(result.cleared, true);
    assert.equal(typed, text);
    assert.equal(submits, 1);
    assert.equal(launches, 1);
  } finally { await closeWatchBrowser(); chromium.launch = launch; }
});

test('ambiguous API result is not retried', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw Error('synthetic lost response'); };
  try {
    const result = await __debug.replyToComment('1', '3', '这个观点值得讨论', { cookie: 'DedeUserID=789; bili_jct=synthetic' }, { ownerIds: ['123456'] });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'net');
    assert.equal(calls, 1);
    assert.equal((await __debug.replyToComment('1', '3', '另一条', { cookie: 'DedeUserID=789; bili_jct=synthetic' }, { ownerIds: ['123456'] })).code, 'comment_already_reserved');
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});
