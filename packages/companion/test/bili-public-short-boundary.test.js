import test from 'node:test';
import assert from 'node:assert/strict';
import { __debug } from '../src/bili-living.js';
import { sendReservedReply } from '../src/bili-comment-send.js';
import { browserComment, closeWatchBrowser } from '../src/bili-browser.js';
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.BILI_COMMENT_LEDGER_DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bili-short-'));

test('public comment API boundaries reject oversized text before sending', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => { calls.push({url, opts}); return { ok:true, json: async () => ({code:0}) }; };
  const headers = {cookie:'DedeUserID=789; bili_jct=fixture'};
  const ownerIds = ['123456'];
  try {
    for (const send of [
      text => __debug.postComment(1, text, headers, {ownerIds}),
      text => __debug.replyToComment(1, 2, text, headers, {ownerIds}),
    ]) {
      const exact = '鱼'.repeat(49) + '🐟';
      assert.equal((await send(exact)).ok, true);
      const count = calls.length;
      assert.equal(new URLSearchParams(calls.at(-1).opts.body).get('message'), exact);
      const denied = await send(exact + '鱼');
      assert.equal(denied.code, 'reply_too_long');
      assert.equal(denied.ok, false);
      assert.equal(calls.length, count);
    }
    const direct = await sendReservedReply({account:'789',aid:1,root:3,message:'鱼'.repeat(51),headers});
    assert.equal(direct.code, 'reply_too_long');
    assert.equal(calls.length, 2);
    const blocked = await browserComment('fixture', '鱼'.repeat(51), {}, {ownerIds});
    assert.equal(blocked.code, 'reply_too_long');
    assert.equal(blocked.ok, false);
    assert.equal(calls.length, 2);
  } finally { globalThis.fetch = original; }
});

test('browser sends exact 50 once and rejects changed editor content', async () => {
  const launch = chromium.launch;
  let typed = '', submits = 0, changed = false;
  const editor = { first() { return this; }, async waitFor() {}, async click() {}, async innerText() { return changed ? typed + '鱼' : (submits ? '' : typed); } };
  const button = { first() { return this; }, async waitFor() {}, async evaluate() { return false; }, async click() { submits++; } };
  let ev = 0;
  const page = { async goto() {}, async waitForTimeout() {}, async evaluate() { return ++ev % 3 === 2 ? {aid:33,bvid:'synthetic'} : ''; }, locator(s) { return s.startsWith('div') ? editor : button; }, keyboard: { async type(s) { typed = s; } } };
  chromium.launch = async () => ({ isConnected: () => true, async close() {}, async newContext() { return { async addCookies() {}, async newPage() { return page; }, async close() {} }; } });
  try {
    const exact = '鱼'.repeat(49) + '🐟';
    const first = await browserComment('synthetic', exact, {dedeuserid:'789'}, {aid:33, ownerIds:['123456'], typeDelay:0});
    assert.equal(first.ok, false);
    assert.equal(first.cleared, true);
    assert.equal(typed, exact);
    assert.equal(submits, 1);
    changed = true;
    const altered = await browserComment('synthetic', exact, {dedeuserid:'789'}, {aid:33, ownerIds:['123456'], typeDelay:0});
    assert.equal(altered.ok, false);
    assert.equal(altered.error, '输入框没吃进去');
    assert.equal(submits, 1);
  } finally { await closeWatchBrowser(); chromium.launch = launch; }
});
