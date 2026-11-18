import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { handleTurn } from '../src/index.js';
import { OneBot } from '../src/transport-onebot.js';
import { register } from 'node:module';
register('./memory-brain-fake-ws-loader.js', import.meta.url);

async function trustedItems(items) {
  let resolve;
  const queue = [];
  const bot = new OneBot({ wsUrl: 'ws://fixture', onMessage: msg => { if (resolve) { const done = resolve; resolve = null; done(msg); } else queue.push(msg); } });
  bot.api = async () => ({ok:false});
  while (!bot.ws) await new Promise(r => setTimeout(r, 1));
  bot.ws.emit('open');
  try {
    const result = [];
    for (const item of items) {
      const next = new Promise(r => { if (queue.length) r(queue.shift()); else resolve = r; });
      bot.ws.emit('message', JSON.stringify({post_type:'message', message_type:item.isGroup?'group':'private', user_id:Number(item.userId), group_id:9, message_id:123, sender:{nickname:item.name}, message:[{type:'text', data:{text:item.text}}]}));
      result.push(await next);
    }
    return result;
  } finally { bot.close(); }
}

async function withDir(fn) {
  const dir = await fs.mkdtemp(path.join(process.env.TMPDIR, 'hongguo-chat-'));
  try { await fn(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

async function chat(dir, userId, isGroup, text, items) {
  const prompts = [];
  const deps = { brain: { reply: async p => { prompts.push(p); return { text: '' }; } }, memory: { dir }, bot: {}, human: {}, waker: {} };
  const batch = await trustedItems(items || [{ key: isGroup ? 'group:9' : `private:${userId}`, userId, name: '测试', isGroup, text }]);
  await handleTurn(deps, batch, { ownerIds: ['1'], dataDir: dir });
  assert.equal(prompts.length, 1);
  return prompts[0].situation;
}

test('主人私聊命中关键词时注入红果兴趣记忆并提示OCR不可靠', async () => withDir(async dir => {
  await fs.writeFile(path.join(dir, 'hongguo-viewing.jsonl'), JSON.stringify({ source: '红果屏幕OCR（可能有误，非音频或确认字幕）', episodeId: 'ep1', summary: '画面文字提到神秘花园', keywords: ['花园'] }) + '\n');
  const situation = await chat(dir, '1', false, '说说花园');
  assert.match(situation, /画面文字提到神秘花园/);
  assert.match(situation, /红果/);
  assert.match(situation, /OCR可能有误/);
}));

test('不相关话题、陌生人私聊及主人或陌生人群聊不注入记忆', async () => withDir(async dir => {
  await fs.writeFile(path.join(dir, 'hongguo-viewing.jsonl'), JSON.stringify({ source: '红果屏幕OCR', episodeId: 'ep1', summary: '秘密画面标记', keywords: ['花园'] }) + '\n');
  for (const [id, group, text] of [['1', false, '天气不错'], ['2', false, '说说花园'], ['1', true, '说说花园'], ['2', true, '说说花园']]) {
    assert.doesNotMatch(await chat(dir, id, group, text), /秘密画面标记|此前观看红果/);
  }
}));

test('发信人昵称包含关键词但正文无关时不召回', async () => withDir(async dir => {
  await fs.writeFile(path.join(dir, 'hongguo-viewing.jsonl'), JSON.stringify({ source: '红果屏幕OCR', episodeId: 'ep1', summary: '秘密画面标记', keywords: ['花园'] }) + '\n');
  const items = [{ key: 'private:1', userId: '1', name: '花园', isGroup: false, text: '天气不错' }];
  assert.doesNotMatch(await chat(dir, '1', false, '天气不错', items), /秘密画面标记|此前观看红果/);
}));

test('混入其他用户的合并批次不注入记忆', async () => withDir(async dir => {
  await fs.writeFile(path.join(dir, 'hongguo-viewing.jsonl'), JSON.stringify({ source: '红果屏幕OCR', episodeId: 'ep1', summary: '秘密画面标记', keywords: ['花园'] }) + '\n');
  const items = [{ key: 'private:1', userId: '2', name: '他人', isGroup: false, text: '花园' }, { key: 'private:1', userId: '1', name: '主人', isGroup: false, text: '花园' }];
  assert.doesNotMatch(await chat(dir, '1', false, '花园', items), /秘密画面标记|此前观看红果/);
}));

test('损坏记录跳过，缺失文件或读取失败仍正常聊天', async () => withDir(async dir => {
  const file = path.join(dir, 'hongguo-viewing.jsonl');
  await fs.writeFile(file, '{broken\nnull\n' + JSON.stringify({ source: '红果屏幕OCR', episodeId: 'ep1', summary: '秘密画面标记', keywords: ['花园'] }) + '\n');
  assert.match(await chat(dir, '1', false, '花园'), /秘密画面标记/);
  await fs.rm(file);
  assert.doesNotMatch(await chat(dir, '1', false, '花园'), /此前观看红果/);
  await fs.mkdir(file);
  assert.doesNotMatch(await chat(dir, '1', false, '花园'), /此前观看红果/);
}));
