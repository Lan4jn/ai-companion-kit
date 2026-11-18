import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Relationship } from '../src/relationship.js';
import { handleTurn } from '../src/index.js';

const day = 86400e3;
function ledger(t) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'trust-tiers-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, rel: new Relationship({ dir }) };
}

test('信任分档边界与陌生人默认值', t => {
  const { rel } = ledger(t);
  assert.equal(rel.trustTier('unknown'), 'normal');
  for (const [value, expected] of [[39, 'guarded'], [40, 'normal'], [74, 'normal'], [75, 'open']]) {
    rel.book.a = { intimacy: 0, trust: value, lastSeen: Date.now() };
    assert.equal(rel.trustTier('a'), expected);
  }
});

test('信任随时间向中间衰减，开放档跌回普通档', t => {
  const { rel } = ledger(t);
  rel.book.a = { intimacy: 85, trust: 90, lastSeen: Date.now() - 30 * day };
  assert.equal(rel.trustTier('a'), 'normal');
});

test('亲密度与信任分档互不影响', t => {
  const { rel } = ledger(t);
  rel.book.a = { intimacy: 85, trust: 20, lastSeen: Date.now() };
  rel.book.b = { intimacy: 10, trust: 90, lastSeen: Date.now() };
  assert.equal(rel.permissionFor('a').familiar, true);
  assert.equal(rel.trustTier('a'), 'guarded');
  assert.equal(rel.permissionFor('b').familiar, false);
  assert.equal(rel.trustTier('b'), 'open');
});

test('真实对话入口按信任分档生成私事提示，亲密边界独立', async t => {
  const { dir, rel } = ledger(t);
  const calls = [];
  const brain = { reply: async input => { calls.push(input); return { text: '嗯' }; } };
  const memory = { dir, renderPerson:()=>'', renderRecent:()=>'', sessionTurns:()=>[], remember:()=>{}, logTurn:()=>{}, touch:()=>{} };
  const bot = { send:async()=>({ok:true}), setTyping:async()=>{}, getMyGroupCard:async()=>'' };
  const human = { say:async(text,{send})=>{ await send(text); return {ok:true,sent:1,parts:[text]}; } };
  for (const [userId, intimacy, trust] of [['open',10,90], ['normal',10,50], ['guarded',85,20]]) {
    rel.book[userId] = { intimacy, trust, lastSeen: Date.now() };
    const item = {key:`private:${userId}`,platform:'qq',isGroup:false,userId,name:userId,text:'你在干嘛',images:[],raw:{},isAtMe:true,isPoke:false,replyTo:null,messageId:userId,time:Date.now()};
    await handleTurn({bot,brain,human,memory,rel,waker:{wake:()=>{}}},[item],{ownerIds:[],dataDir:dir});
  }
  assert.equal(calls.length, 3);
  for (const { situation } of calls) {
    const section = situation.match(/【能不能跟他说实话】([^\n]*)/)?.[1];
    assert.ok(section);
    assert.match(section, /不要套用固定句式/);
    assert.match(section, /不要模板化拒答/);
    assert.doesNotMatch(section, /\d|permission|规则|threshold|抱歉，您的问题我无法识别|无法提供相关内容/i);
    assert.doesNotMatch(situation, /亲密度\s*[-\d]|信任\s*\d|permission|规则|threshold/i);
  }
  assert.match(calls[0].situation, /【能不能跟他说实话】.*真实.*刷到.*日记.*不糊弄/);
  assert.match(calls[1].situation, /【能不能跟他说实话】.*正常聊.*私事.*带过.*不展开/);
  assert.match(calls[2].situation, /【能不能跟他说实话】.*不主动.*追问.*带过.*转移话题.*不交心.*不解释原因/);
  assert.match(calls[0].situation, /不太喜欢.*可以.*不喜欢/);
  assert.match(calls[2].situation, /很亲近的人.*默许/);
});
