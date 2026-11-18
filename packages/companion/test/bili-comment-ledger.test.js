import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bili-guard-test-'));
process.env.BILI_COMMENT_LEDGER_DIR = root;
const { __debug } = await import('../src/bili-living.js');
const headers = {cookie:'DedeUserID=123; bili_jct=synthetic'};
test('unknown submission is durable and blocks retry', async () => {
  let n=0; const original=globalThis.fetch;
  globalThis.fetch=async()=>{n++; throw Error('unknown');};
  try {
    await __debug.postComment(70001,'真实视频很有意思',headers,{ownerIds:['987654']});
    await __debug.postComment(70001,'换个内容',headers,{ownerIds:['987654']});
    assert.equal(n,1);
  } finally {globalThis.fetch=original;}
});

test('reply unknown blocks the same target but not a different one', async () => {
  let n=0; const original=globalThis.fetch;
  globalThis.fetch=async()=>{n++; if(n===1) throw Error('lost'); return {ok:true,json:async()=>({code:0})};};
  try {
    const opts={ownerIds:['987654']};
    assert.equal((await __debug.replyToComment(70002,3,'回复内容很有意思',headers,opts)).code,'net');
    assert.equal((await __debug.replyToComment(70002,3,'换句话回复',headers,opts)).code,'comment_already_reserved');
    assert.equal((await __debug.replyToComment(70002,4,'回复其他评论',headers,opts)).ok,true);
    assert.equal(n,2);
  } finally {globalThis.fetch=original;}
});
