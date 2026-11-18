import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Relationship } from '../src/relationship.js';
import { handleTurn } from '../src/index.js';

const day = 86400e3;
function ledger(t) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'familiar-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, rel: new Relationship({ dir }) };
}
test('亲密度边界及陌生人默认不熟悉', t => {
  const { rel } = ledger(t);
  assert.deepEqual(rel.permissionFor('unknown'), { intimacy: 0, trust: 50, tier: '眼熟的群友', familiar: false });
  rel.book.a = { intimacy: 79, trust: 70, lastSeen: Date.now() };
  rel.book.b = { intimacy: 80, trust: 80, lastSeen: Date.now() };
  assert.deepEqual(rel.permissionFor('a'), { intimacy: 79, trust: 70, tier: '铁瓷', familiar: false });
  assert.deepEqual(rel.permissionFor('b'), { intimacy: 80, trust: 80, tier: '老铁瓷', familiar: true });
});
test('允许覆盖阈值但陌生人始终不熟悉', t => {
  const { dir } = ledger(t);
  const rel = new Relationship({ dir, familiarAt: 20 });
  rel.book.a = { intimacy: 20, trust: 50, lastSeen: Date.now() };
  assert.equal(rel.permissionFor('a').familiar, true);
  assert.equal(new Relationship({ dir, familiarAt: 0 }).permissionFor('unknown').familiar, false);
});
test('读取时衰减，不因反复读取或重新加载重复衰减', t => {
  const { dir, rel } = ledger(t);
  rel.book.a = { intimacy: 100, trust: 80, lastSeen: Date.now() - 30 * day };
  assert.equal(rel.permissionFor('a').familiar, false);
  assert.ok(Math.abs(rel.permissionFor('a').intimacy - 50) < 0.01);
  rel._save();
  const first = new Relationship({ dir });
  const second = new Relationship({ dir });
  assert.ok(Math.abs(first.permissionFor('a').intimacy - second.permissionFor('a').intimacy) < 0.01);
});

test('普通互动保留高亲密度，并先计算衰减再更新', t => {
  const { rel } = ledger(t);
  rel.book.close = { intimacy: 95, trust: 75, lastSeen: Date.now() };
  rel.observe('close', '你好');
  assert.equal(rel.permissionFor('close').familiar, true);
  rel.book.stale = { intimacy: 100, trust: 80, lastSeen: Date.now() - 30 * day };
  rel.observe('stale', '你好');
  assert.ok(Math.abs(rel.permissionFor('stale').intimacy - 50.4) < 0.01);
  assert.equal(rel.permissionFor('stale').familiar, false);
});

test('真实对话提示词对拍一拍和外号按当前发言者区分', async t => {
  const { dir, rel } = ledger(t);
  rel.book.close = { intimacy: 80, trust: 75, lastSeen: Date.now() };
  rel.book.other = { intimacy: 79, trust: 75, lastSeen: Date.now() };
  const calls = [];
  const brain = { reply: async input => { calls.push(input); return { text: '嗯' }; } };
  const memory = { dir, renderPerson:()=>'', renderRecent:()=>'', sessionTurns:()=>[], remember:()=>{}, logTurn:()=>{}, touch:()=>{} };
  const bot = { send:async()=>({ok:true}), setTyping:async()=>{}, getMyGroupCard:async()=>'' };
  const human = { say:async(text,{send})=>{ await send(text); return {ok:true,sent:1,parts:[text]}; } };
  for (const [userId, isPoke, text] of [['close',true,''], ['other',true,''], ['close',false,'小肥鱼'], ['other',false,'鱼形RBQ']]) {
    const item = {key:`private:${userId}`,platform:'qq',isGroup:false,userId,name:userId,text,images:[],raw:{},isAtMe:true,isPoke,replyTo:null,messageId:userId,time:Date.now()};
    await handleTurn({bot,brain,human,memory,rel,waker:{wake:()=>{}}},[item],{ownerIds:[],dataDir:dir});
  }
  assert.equal(calls.length, 4);
  for (const [i, {situation}] of calls.entries()) {
    assert.match(situation, /不要套用固定句式/);
    assert.match(situation, /不要模板化拒答/);
    assert.match(situation, /肥鱼/);
    assert.doesNotMatch(situation, /抱歉，您的问题我无法识别|无法提供相关内容/);
    if (i % 2 === 0) assert.match(situation, /很亲近的人.*默许/);
    else assert.match(situation, /不太喜欢.*可以.*不喜欢/);
    if (i < 2) assert.match(situation, /戳了戳/);
  }
});
