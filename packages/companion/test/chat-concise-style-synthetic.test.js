import test from 'node:test';
import assert from 'node:assert/strict';
import { handleTurn } from '../src/index.js';

for (const [label, isGroup, owner] of [['群友', true, false], ['主人', false, true]]) {
  test(`合成${label}对话的提示自然且超长代码失败时静默`, async () => {
    const calls = [], sent = [];
    const long = '事实、引用和代码：`const x = 1;`。'.repeat(30);
    const short = '事实、引用和代码：' + '`const x = 1;`。'.repeat(30);
    const brain = {reply: async input => { calls.push(input); return {text: calls.length === 1 ? '听着不错' : long}; }, rewriteConciseDraft: async () => short, verifyConciseDraft: async () => true};
    const memory = {renderPerson:()=>'',renderRecent:()=>'',sessionTurns:()=>[],remember:()=>{},logTurn:()=>{},touch:()=>{}};
    const bot = {send:async (_key,text)=>{sent.push(text);return {ok:true}},setTyping:async()=>{},getMyGroupCard:async()=>''};
    const human = {say:async(text,{send})=>{const parts=Array.isArray(text)?text:[text]; for (const part of parts) await send(part); return {ok:true,sent:parts.length,parts}}};
    for (const text of ['今晚想吃甜点', '请详细解释并给出代码']) {
      const item = {key:isGroup?'group:42':'private:42',isGroup,groupId:isGroup?'42':'',userId:'42',name:'fixture',text,images:[],raw:{},isAtMe:true,isPoke:false,replyTo:null,messageId:'fixture',time:Date.now()};
      await handleTurn({bot,brain,human,memory,waker:{wake:()=>{}}},[item],{ownerIds:owner?['42']:[],dataDir:process.env.TMPDIR});
    }
    assert.equal(calls.length, 2);
    for (const {situation} of calls) {
      assert.match(situation, /接住对方此刻的意思/);
      assert.match(situation, /表达一点自己的态度/);
      assert.match(situation, /一句话已经说到位就停/);
      assert.match(situation, /不要为了显得生动硬编自己的经历/);
      assert.match(situation, /主人和群友都按同样的自然表达原则/);
      assert.match(situation, /闲聊.*可以说长一些/);
      assert.match(situation, /事实、引用和代码等要准确完整/);
      assert.match(situation, /认真提问，先给直接答案/);
      assert.match(situation, /必需的事实、步骤、条件和必要安全说明/);
      assert.match(situation, /复杂问题按需要解释清楚/);
      assert.match(situation, /不机械限制字数，不截断回答/);
      assert.doesNotMatch(situation, /会胖\s*但我支持/);
    }
    assert.deepEqual(sent, ['听着不错']);
  });
}
