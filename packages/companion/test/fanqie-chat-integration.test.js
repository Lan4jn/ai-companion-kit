import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { handleTurn } from '../src/index.js';
import { saveFanqieMemory, recallFanqie, readFanqieOnce } from '../src/fanqie-session.js';

async function withDir(fn) {
  const dir = await fs.mkdtemp(path.join(process.env.TMPDIR, 'fanqie-chat-'));
  try { await fn(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

test('损坏的JSONL行不阻止有效阅读记忆召回', async () => withDir(async dir => {
  await saveFanqieMemory(dir, { source: 'OCR', summary: '人物在营地庆生', keywords: ['营地'] });
  await fs.appendFile(path.join(dir, 'fanqie-reading.jsonl'), '{broken\nnull\n');
  assert.equal((await recallFanqie(dir, '营地怎么样')).length, 1);
}));

test('真实聊天处理只在主人私聊命中时注入阅读记忆', async () => withDir(async dir => {
  const read = await readFanqieOnce({
    capture: async () => ({ text: '可见正文：人物在营地庆生', fingerprint: 'page-1', source: '番茄小说屏幕OCR' }),
    understand: async () => ({ interested: true, summary: '人物在营地庆生', keywords: ['营地'] }),
    save: record => saveFanqieMemory(dir, record),
  });
  assert.equal(read.ok, true);
  const prompts = [];
  const deps = { brain: { reply: async p => { prompts.push(p); return { text: '' }; } }, memory: { dir }, bot: {}, human: {}, waker: {} };
  const cfg = { ownerIds: ['1'], dataDir: dir };
  for (const [userId, isGroup, text] of [['1', false, '说说营地'], ['1', false, '天气真好'], ['2', false, '说说营地'], ['1', true, '说说营地']]) {
    await handleTurn(deps, [{ key: isGroup ? 'group:9' : `private:${userId}`, userId, name: '测试', isGroup, text }], cfg);
  }
  assert.equal(prompts.length, 4);
  assert.match(prompts[0].situation, /人物在营地庆生/);
  assert.match(prompts[0].situation, /番茄小说屏幕OCR/);
  for (const p of prompts.slice(1)) assert.doesNotMatch(p.situation, /人物在营地庆生/);
}));
