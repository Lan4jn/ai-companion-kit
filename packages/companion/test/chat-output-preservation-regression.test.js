import test from 'node:test';
import assert from 'node:assert/strict';
import { handleTurn } from '../src/index.js';
import { Brain } from '../src/brain.js';
import { Humanizer } from '../src/humanize.js';

async function run(t, content, key, rewritten = null) {
  let call = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    const output = call++ === 0 ? content : (call === 2 ? rewritten : 'PASS');
    const data = {choices:[{finish_reason:'stop',message:{content:output}}]};
    return {ok:true,text:async()=>JSON.stringify(data),json:async()=>data};
  });
  const memory={renderPerson:()=>'',renderRecent:()=>'',sessionTurns:()=>[],remember:()=>{},logTurn:()=>{},touch:()=>{}};
  const brain=new Brain({apiKey:'fixture',baseUrl:'https://fixture.invalid',model:'fixture',memory});
  const sent=[];
  const bot={send:async(k,m)=>{sent.push(m);return {ok:true,data:{message_id:123}}},setTyping:async()=>{},getMyGroupCard:async()=>''};
  const human=new Humanizer({enabled:false});
  const isGroup=key.includes('group:');
  const item={key,isGroup,groupId:isGroup?'42':'',userId:'42',name:'fixture',text:'请完整说明',images:[],raw:{},isAtMe:true,isPoke:false,replyTo:null,messageId:'fixture',time:Date.now()};
  await handleTurn({bot,brain,human,memory,waker:{wake:()=>{}}},[item],{ownerIds:[],dataDir:process.env.TMPDIR});
  return sent;
}

test('real chat preserves factual brackets, markdown and punctuation within 50 code points',async t=>{
  const reply='[注意] 报价 500 元（含税），**保修三年**。\n\n'+ '详细说明：产品包含配件和服务。'.repeat(40)+'\n代码：`f(x)`；公式：a * b。';
  const rewritten='[注意] 500元（含税），**保修三年**；含配件服务。`f(x)`，a * b。';
  assert.ok(Array.from(rewritten).length <= 50);
  assert.deepEqual(await run(t,reply,'private:342',rewritten),[rewritten]);
});

test('real chat suppresses a faithful but oversized rewrite',async t=>{
  const reply='[注意] 报价 500 元（含税），**保修三年**。\n\n'+ '详细说明：产品包含配件和服务。'.repeat(40)+'\n代码：`f(x)`；公式：a * b。';
  const rewritten='[注意] 报价 500 元（含税），**保修三年**。产品包含配件和服务。代码：`f(x)`；公式：a * b。';
  assert.ok(Array.from(rewritten).length > 50);
  assert.deepEqual(await run(t,reply,'private:342',rewritten),[]);
});

test('unfinished private draft is never delivered',async t=>{
  const sent=await run(t,'正常回答。（（心情: 私密草稿未闭合','wx:private:343');
  assert.doesNotMatch(sent.join(''),/私密草稿/);
});
