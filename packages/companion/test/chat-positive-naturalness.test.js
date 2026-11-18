import test from 'node:test';
import assert from 'node:assert/strict';
import { handleTurn } from '../src/index.js';
import { register } from 'node:module';
import { OneBot } from '../src/transport-onebot.js';
import { Humanizer } from '../src/humanize.js';
import { chatLengthGuidance } from '../src/chat-length-guidance.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
register('./memory-brain-fake-ws-loader.js', import.meta.url);

for (const isGroup of [false, true]) {
  test(`合成多轮${isGroup ? '群聊' : '私聊'}生成前收到接话策略，精简失败时静默`, async t => {
    const history = [{role:'user',content:'我今天试了新菜'}, {role:'assistant',content:'味道怎么样？'}];
    const calls = [], sent = [];
    const longAnswer = '第一步检查输入。第二步核对条件。第三步处理异常。'.repeat(12);
    const brain = {reply: async input => {calls.push(input); return {text: calls.length === 1 ? '听起来挺有意思。' : longAnswer};}};
    const memory = {renderPerson:()=>'',renderRecent:()=>'',sessionTurns:()=>history,remember:()=>{},logTurn:()=>{},touch:()=>{}};
    const bot = {send:async (_key,text)=>{sent.push(text);return {ok:true}},setTyping:async()=>{},getMyGroupCard:async()=>''};
    const human = new Humanizer({enabled:false});
    let receive;
    const dataDir = mkdtempSync(join(tmpdir(), 'chat-naturalness-'));
    const ingress = new OneBot({wsUrl:'ws://fixture',dataDir,onMessage: item => receive(item)});
    ingress.api = async()=>({ok:false});
    t.after(()=>{ ingress.close(); rmSync(dataDir,{recursive:true,force:true}); });
    while (!ingress.ws) await new Promise(resolve=>setTimeout(resolve,5));
    // The transport now accepts messages only after its socket is open.
    ingress.ws.emit('open');
    for (const text of ['我加了番茄', '请详细解释排查步骤']) {
      const next = new Promise(resolve=>{receive=resolve});
      ingress.ws.emit('message',JSON.stringify({post_type:'message',message_type:isGroup?'group':'private',group_id:isGroup?42:undefined,user_id:42,self_id:99,message_id:1,message:[{type:'text',data:{text}}],sender:{nickname:'fixture'}}));
      const item = await next;
      await handleTurn({bot,brain,human,memory,waker:{wake:()=>{}}},[item],{ownerIds:[],dataDir});
    }
    assert.equal(calls.length,2);
    for (const call of calls) {
      // Group ingress intentionally carries no trusted private-memory capability.
      assert.deepEqual(call.history, isGroup ? [] : history);
      assert.ok(call.situation.includes(chatLengthGuidance(isGroup)), '实际生成请求应包含对应场景的完整长度提示');
      assert.match(call.situation,/当前.*具体.*(?:细节|信息)/);
      assert.match(call.situation,/最近几轮.*(?:重复|相同)/);
      assert.match(call.situation,/不必.*(?:强行|刻意).*(?:变化|换)/);
      assert.match(call.situation,/认真.*(?:完整|解释清楚)/);
    }
    assert.deepEqual(sent,['听起来挺有意思。']);
    assert.ok(Array.from(longAnswer).length > 50);
  });
}
