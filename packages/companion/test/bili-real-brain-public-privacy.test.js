import test from 'node:test';
import assert from 'node:assert/strict';
import { Brain } from '../src/brain.js';
import { draftDanmaku } from '../src/bili-grow.js';
import { __debug } from '../src/bili-living.js';
import { OneBot } from '../src/transport-onebot.js';
import { register } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
register('./memory-brain-fake-ws-loader.js', import.meta.url);

async function qqEvent(user = 1, type = 'private') {
  let resolve;
  const received = new Promise(r => { resolve = r; });
  const bot = new OneBot({ wsUrl: 'ws://fixture', onMessage: resolve });
  bot.api = async () => ({ ok: false });
  while (!bot.ws) await new Promise(r => setTimeout(r, 1));
  bot.ws.emit('open');
  bot.ws.emit('message', JSON.stringify({ post_type: 'message', message_type: type, user_id: user, group_id: 55, message_id: 123, message: [{ type: 'text', data: { text: '私聊' } }] }));
  const event = await received;
  bot.close();
  return event;
}

const video = { title: '公开视频', up: '作者' };

test('public B站 drafts use real Brain without private context or tools', async t => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'bili-public-privacy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: requests.length === 1 ? '这个画面很有趣' : '{"want":true,"reply":true,"text":"这个片段真的挺有意思"}' } }] }) };
  };
  const brain = new Brain({ apiKey: 'test', baseUrl: 'http://invalid.local', model: 'test',
    role: { build: ({ situation = '', memory = '', recent = '' } = {}) => `PRIVATE_ROLE_SENTINEL ${situation} ${memory} ${recent}` },
    memory: { renderPerson: () => 'PRIVATE_PERSON_SENTINEL', renderDiary: () => 'PRIVATE_DIARY_SENTINEL', renderRecent: () => 'PRIVATE_RECENT_SENTINEL', recallTurns: () => [{ text: 'PRIVATE_RECALL_SENTINEL' }], recallBiliFeelings: () => 'PRIVATE_FEELING_SENTINEL' },
    recall: () => [{ title: 'PRIVATE_KNOWLEDGE_SENTINEL' }], ownerIds: ['1'], dataDir: dir,
  });
  try {
    assert.ok(await draftDanmaku(brain, video, '公开素材', { mood: 'PRIVATE_MOOD_SENTINEL' }));
    assert.ok(await __debug.draftComment(brain, video, '公开素材'));
    assert.ok(await __debug.draftMentionReply(brain, { isOwner: true, who: '观众', title: '视频', said: '好看' }));
    assert.ok(await __debug.draftReachComment(brain, video, '公开素材'));
    assert.equal(requests.length, 4);
    for (const request of requests) {
      assert.ok(request.messages[0].content.length > 0);
      assert.doesNotMatch(JSON.stringify(request), /PRIVATE_\w+_SENTINEL/);
      assert.equal(request.tools, undefined);
      assert.equal(request.messages.length, 2);
    }
    assert.match(brain.role.build(), /PRIVATE_ROLE_SENTINEL/);
    assert.equal(brain.memory.renderPerson(), 'PRIVATE_PERSON_SENTINEL');
    const owner = await qqEvent();
    await brain.reply({ key: owner.key, userId: owner.userId, qqEvent: owner, text: '私聊', history: [{ text: 'PRIVATE_HISTORY_SENTINEL' }], record: false });
    const privateRequest = JSON.stringify(requests[4]);
    for (const marker of ['ROLE', 'RECALL', 'KNOWLEDGE', 'HISTORY', 'FEELING']) {
      assert.ok(privateRequest.includes(`PRIVATE_${marker}_SENTINEL`), marker);
    }
    for (const marker of ['PERSON', 'DIARY', 'RECENT']) {
      assert.ok(!privateRequest.includes(`PRIVATE_${marker}_SENTINEL`), marker);
    }
    assert.ok(requests[4].tools?.length);
    for (const event of [await qqEvent(2), await qqEvent(1, 'group'), { ...owner }]) {
      await brain.reply({ key: event.key, userId: event.userId, qqEvent: event, text: '私聊', record: false, tools: false });
      const request = JSON.stringify(requests.at(-1));
      assert.doesNotMatch(request, /PRIVATE_(?:FEELING|KNOWLEDGE)_SENTINEL/);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('disabled tools cannot execute unsolicited provider tool calls', async () => {
  let count = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    count++;
    return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: '正常回复', tool_calls: [{ id: 'test', type: 'function', function: { name: 'phone_shell', arguments: '{}' } }] } }] }) };
  };
  const brain = new Brain({ apiKey: 'test', baseUrl: 'http://invalid.local', model: 'test',
    role: { build: () => 'private role' }, memory: { renderPerson: () => '', renderRecent: () => '' } });
  try {
    const out = await brain.reply({ key: 'private:test', userId: 'test', text: 'hi', record: false, tools: false });
    assert.equal(out.text, '正常回复');
    assert.equal(count, 1);
  } finally { globalThis.fetch = originalFetch; }
});
