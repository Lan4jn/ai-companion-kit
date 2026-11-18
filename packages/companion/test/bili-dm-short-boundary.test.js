import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { __debug, parseBiliDMReply } from '../src/bili-living.js';

const headers = { cookie: 'bili_jct=synthetic; DedeUserID=123' };
const ownerIds = ['876543210'];

test('B站私信实际出口：50 字原样发送，51 字静默拒绝', async () => {
  const home = fs.mkdtempSync(path.join(process.cwd(), '.bili-test-home-'));
  const oldHome = process.env.HOME, oldFetch = globalThis.fetch;
  const calls = [];
  process.env.HOME = home;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { json: async () => ({ code: 0, data: { msg_key: 'synthetic' } }) };
  };
  try {
    const send = text => __debug.sendDM(1, text, headers, { ownerIds });
    const exact = '鱼'.repeat(49) + '🐟';
    assert.equal((await send(exact)).ok, true);
    assert.equal(JSON.parse(new URLSearchParams(calls[0].opts.body).get('msg[content]')).content, exact);
    const result = await send(exact + '鱼');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'reply_too_long');
    for (const text of ['鱼'.repeat(25) + '\n' + '鱼'.repeat(25), '鱼'.repeat(31) + 'https://example.com/a']) {
      assert.equal((await send(text)).code, 'reply_too_long');
    }
    for (const text of [null, undefined, '', '  ', ['鱼'.repeat(30), '鱼'.repeat(30)], { type: 'image', url: 'synthetic' }]) {
      assert.equal((await send(text)).code, 'invalid_text');
    }
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = oldFetch;
    process.env.HOME = oldHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('unknown delivery is not success and the transport is not retried', async () => {
  const home = fs.mkdtempSync(path.join(process.cwd(), '.bili-test-home-'));
  const oldHome = process.env.HOME, oldFetch = globalThis.fetch;
  let requests = 0;
  process.env.HOME = home;
  globalThis.fetch = async () => { requests++; throw new Error('synthetic timeout'); };
  try {
    const result = await __debug.sendDM(1, '你好', headers, { ownerIds });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'net');
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = oldFetch;
    process.env.HOME = oldHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('模型解析不得将超长原文静默截断', () => {
  const text = '鱼'.repeat(201);
  assert.equal(parseBiliDMReply(JSON.stringify({ reply: true, text })), null);
  assert.equal(parseBiliDMReply(JSON.stringify({reply:true,text:'🐟'.repeat(50)})), '🐟'.repeat(50));
  assert.equal(parseBiliDMReply(JSON.stringify({reply:true,text:'🐟'.repeat(51)})), null);
});
