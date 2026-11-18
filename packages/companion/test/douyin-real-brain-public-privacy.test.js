import test from 'node:test';
import assert from 'node:assert/strict';
import { Brain } from '../src/brain.js';
import { generateDouyinComment, submitDouyinComment } from '../src/douyin-living.js';

test('real Brain public decision uses only allowlisted public evidence and honors skip', async () => {
  const requests = [];
  const old = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"comment":false,"text":"不要发"}' } }] }) };
  };
  const brain = new Brain({ apiKey: 'test', baseUrl: 'http://invalid.local', model: 'test',
    role: { build: () => 'PRIVATE_ROLE_SENTINEL' },
    memory: { renderPerson: () => 'PRIVATE_PERSON_SENTINEL', renderDiary: () => 'PRIVATE_DIARY_SENTINEL', recallTurns: () => [{text:'PRIVATE_CHAT_SENTINEL'}] },
    recall: () => ['PRIVATE_RECALL_SENTINEL'] });
  try {
    const result = await generateDouyinComment(brain, { title: '公开作品', author: '公开作者', topComments: ['公开评论'], perception: { frames: [{ time: 1, description: '公开视频画面' }] }, private: 'PRIVATE_EXTRA_SENTINEL' });
    assert.equal(result, '');
    assert.equal(requests.length, 1);
    const payload = JSON.stringify(requests[0]);
    assert.match(payload, /公开作品/);
    assert.doesNotMatch(payload, /PRIVATE_\w+_SENTINEL/);
    assert.equal(requests[0].tools, undefined);
    assert.equal(requests[0].messages.length, 2);
  } finally { globalThis.fetch = old; }
});

test('invalid decision or provider failure fails closed', async () => {
  const info = { title: '公开视频' };
  for (const raw of ['not json', '{}', '{"comment":"true","text":"内容"}', '{"comment":true,"text":7}', null]) {
    assert.equal(await generateDouyinComment({ complete: async () => raw }, info), '');
  }
  assert.equal(await generateDouyinComment({ complete: async () => { throw new Error('offline'); } }, info), '');
});

test('public submission rejects common personal data and private context before send', async () => {
  let count = 0;
  const send = async () => { count++; return true; };
  for (const value of ['我的电话是13800138000', '住在北京市朝阳区幸福小区3号', '私聊里你说过很难过', '密码是secret123', '邮箱a@example.com']) {
    assert.equal(await submitDouyinComment(value, ['123456789'], send), false, value);
  }
  assert.equal(count, 0);
});
