import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleTurn } from '../src/index.js';
import { Humanizer } from '../src/humanize.js';
import { ChatBatchQueue } from '../src/chat-batch-queue.js';
import { Waker } from '../src/wake.js';
import { initGrowth, observeIncoming } from '../src/growth.js';

function setup(t, send) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'dm-send-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const deps = {
    bot: { send, setTyping: async () => {} },
    brain: { reply: async () => ({ text: '你好呀' }) },
    human: new Humanizer({ enabled: false }),
    memory: { dir, touch: () => calls.push('touch') },
    waker: { wake: () => calls.push('wake') },
    personaReflector: { consider: () => calls.push('consider') },
    respectGuard: { promptLine: () => '', clearNotice: () => calls.push('clear') },
  };
  const item = { key: 'private:42', userId: '42', name: '测试', isGroup: false, text: '你好' };
  return { dir, calls, deps, item, run: () => handleTurn(deps, [item], { ownerIds: [], dataDir: dir }) };
}

test('私聊发送失败时返回失败且不更新已回复状态', async t => {
  const h = setup(t, async () => ({ ok: false, error: 'offline' }));
  const result = await h.run();
  assert.equal(result.ok, false);
  assert.equal(result.sent, 0);
  assert.deepEqual(h.calls, []);
  assert.equal(fs.existsSync(path.join(h.dir, 'bridge.log')), false);
});

test('仅确认成功的消息按 OneBot 嵌套消息 ID 进入成长记录', async t => {
  const h = setup(t, async () => ({ ok: true, data: { data: { message_id: 'unique-success-834' } } }));
  initGrowth({ dataDir: h.dir });
  await h.run();
  observeIncoming({ key: h.item.key, userId: '42', name: '测试', text: '真棒', replyTo: 'unique-success-834' });
  const event = JSON.parse(fs.readFileSync(path.join(h.dir, 'growth.jsonl'), 'utf8').trim());
  assert.equal(event.myWords, '你好呀');
});

test('分段部分成功时仅记录已发送内容并传播失败', async t => {
  let n = 0;
  const sentParts = [];
  const h = setup(t, async (_key, part) => { sentParts.push(part); return ++n === 1
    ? { ok: true, data: { data: { message_id: 'partial-ok-471' } } }
    : { ok: false, error: 'offline', data: { message_id: 'partial-fail-472' } }; });
  h.deps.brain.reply = async () => ({ text: '已发送\n\n未发送秘密' });
  initGrowth({ dataDir: h.dir });
  const result = await h.run();
  assert.equal(result.ok, false);
  assert.equal(result.sent, 1);
  assert.equal(result.error, 'offline');
  observeIncoming({ key: h.item.key, userId: '42', text: '真棒', replyTo: 'partial-ok-471' });
  observeIncoming({ key: h.item.key, userId: '42', text: '真棒', replyTo: 'partial-fail-472' });
  const events = fs.readFileSync(path.join(h.dir, 'growth.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(sentParts.length, 2);
  assert.equal(sentParts[0].trim(), '已发送');
  assert.equal(sentParts[1].trim(), '未发送秘密');
  assert.deepEqual(events.map(e => e.myWords), [sentParts[0]]);
  const log = fs.readFileSync(path.join(h.dir, 'bridge.log'), 'utf8');
  assert.ok(!log.includes('未发送秘密'));
  assert.ok(!log.includes('已发送'));
  assert.ok(log.includes('发出 1 条'));
});

test('被拦截的消息即使携带 ID 也不能污染成长记录', async t => {
  const h = setup(t, async () => ({ ok: true, blocked: true, reason: 'blocked', data: { message_id: 'blocked-987' } }));
  initGrowth({ dataDir: h.dir });
  const result = await h.run();
  assert.equal(result.ok, false);
  assert.equal(result.sent, 0);
  observeIncoming({ key: h.item.key, userId: '42', text: '真棒', replyTo: 'blocked-987' });
  assert.equal(fs.existsSync(path.join(h.dir, 'growth.jsonl')), false);
});

test('底层发送抛错时视为送达未知且不更新已回复状态', async t => {
  const h = setup(t, async () => { throw new Error('transport down'); });
  const result = await h.run();
  assert.deepEqual(result, { ok: false, sent: 0, error: 'DELIVERY_UNKNOWN' });
  assert.deepEqual(h.calls, []);
});

test('明确拒绝的首个分段传播未发送证据', async t => {
  const h = setup(t, async () => ({ ok:false, outcome:'permanent', error:'rejected' }));
  assert.deepEqual(await h.run(), {ok:false, sent:0, outcome:'permanent', error:'rejected'});
});

test('已发送部分后即使下一段遭拒也不视为整个回合未发送', async t => {
  let n=0; const h=setup(t, async () => ++n === 1 ? {ok:true} : {ok:false,outcome:'permanent'});
  h.deps.brain.reply=async()=>({text:'已发送\n\n拒绝'});
  const result=await h.run(); assert.equal(result.ok,false); assert.equal(result.sent,1); assert.notEqual(result.outcome,'permanent');
});

test('真实处理入口明确未发送后队列继续且不重放', async t => {
  let sends=0; const h=setup(t, async () => ++sends === 1 ? {ok:false,outcome:'permanent'} : {ok:true});
  const q=new ChatBatchQueue({waker:new Waker(),run:items=>handleTurn(h.deps,items,{ownerIds:[],dataDir:h.dir})});
  for (const text of ['first','second']) { q.add(h.item.key,{...h.item,text},60000); q.flush(h.item.key); }
  await q.drain(); assert.equal(sends,2); assert.equal(q.messageCount,0); q.stop();
});

test('部分成功后结果未知时停止发送且不重试', async t => {
  const sentParts = [];
  const h = setup(t, async (_key, part) => {
    sentParts.push(part);
    return sentParts.length === 1 ? {ok:true} : {ok:false, outcome:'unknown', error:'UNKNOWN'};
  });
  h.deps.brain.reply = async () => ({text:'第一段\n\n第二段\n\n第三段'});
  const result = await h.run();
  assert.equal(result.ok, false);
  assert.equal(result.sent, 1);
  assert.notEqual(result.outcome, 'permanent');
  assert.equal(sentParts.length, 2);
  assert.deepEqual(h.calls, []);
  const log = fs.readFileSync(path.join(h.dir, 'bridge.log'), 'utf8');
  for (const part of ['第一段', '第二段', '第三段']) assert.ok(!log.includes(part));
});

test('拟人发送未确认任何分段时不误认为回复成功', async t => {
  const h = setup(t, async () => ({ ok: true }));
  h.deps.human = { say: async () => ({ sent: 0, parts: [] }) };
  const result = await h.run();
  assert.equal(result.ok, false);
  assert.equal(result.sent, 0);
  assert.deepEqual(h.calls, []);
});
