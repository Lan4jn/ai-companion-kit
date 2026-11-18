import test from 'node:test';
import assert from 'node:assert/strict';
import { browserComment } from '../src/bili-browser.js';
import { postDanmaku } from '../src/bili-grow.js';
import { __debug } from '../src/bili-living.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.BILI_COMMENT_LEDGER_DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bili-outbound-'));

const headers = { cookie: 'bili_jct=test; DedeUserID=123' };
const ownerIds = ['876543210'];

test('all Bilibili text exits block private content and missing configuration before transport', async () => {
  let requests = 0;
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => { requests++; return { json: async () => ({ code: 0 }) }; };
  try {
    const exits = [
      (text, ids) => browserComment('BV1', text, {}, { ownerIds: ids }),
      (text, ids) => postDanmaku({ cid: 1, bvid: 'BV1', msg: text, headers, ownerIds: ids }),
      (text, ids) => __debug.postComment(1, text, headers, { ownerIds: ids }),
      (text, ids) => __debug.replyToComment(1, 2, text, headers, { ownerIds: ids }),
      (text, ids) => __debug.sendDM(1, text, headers, { ownerIds: ids }),
    ];
    for (const send of exits) {
      for (const [text, ids] of [['QQ 876543210', ownerIds], ['[CQ:at,qq=123]', ownerIds], ['safe', undefined], ['safe', 'invalid']]) {
        const result = await send(text, ids);
        assert.equal(result.ok, false);
        assert.equal(result.code, 'privacy_blocked');
      }
    }
    assert.equal(requests, 0);
  } finally { globalThis.fetch = oldFetch; }
});


test('safe API messages reach only the mocked transport with original content', async () => {
  const calls = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, json: async () => ({ code: 0 }) }; };
  try {
    assert.equal((await postDanmaku({ cid: 1, bvid: 'BV1', msg: '你好', headers, ownerIds })).ok, true);
    assert.equal((await __debug.postComment(1, '你好', headers, { ownerIds })).ok, true);
    assert.equal((await __debug.replyToComment(1, 2, '你好', headers, { ownerIds })).ok, true);
    assert.equal((await __debug.sendDM(1, '你好', headers, { ownerIds })).ok, true);
    assert.equal(calls.length, 4);
    assert.equal(new URLSearchParams(calls[0].opts.body).get('msg'), '你好');
    assert.equal(new URLSearchParams(calls[1].opts.body).get('message'), '你好');
    assert.equal(new URLSearchParams(calls[2].opts.body).get('message'), '你好');
    assert.equal(JSON.parse(new URLSearchParams(calls[3].opts.body).get('msg[content]')).content, '你好');
    assert.equal((await __debug.postComment(1, '你好', headers, { ownerIds, dry: true })).dry, true);
    assert.equal(calls.length, 4);
  } finally { globalThis.fetch = oldFetch; }
});
