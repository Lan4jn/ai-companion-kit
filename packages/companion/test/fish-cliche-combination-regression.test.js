import test from 'node:test';
import assert from 'node:assert/strict';
import {hasFishCliche} from '../src/fish-cliche.js';
import {Brain} from '../src/brain.js';
import {handleTurn} from '../src/index.js';

const screenshot = '那句确实不像我说的 一绕就被你绕出机器腔了 行 我认，这局你赢';

test('only complete empty mechanical concession combinations are blocked', () => {
  for (const s of [screenshot, '这句真不像我说的，被你绕出机器人味了，好吧，我服了，这回你赢了！', '又说出AI味了，行，我认了，这次算你赢']) assert.equal(hasFishCliche(s), true, s);
  for (const s of ['这局你赢', '我认，这局你赢', '对不起，这次是我错了', '那句确实不像我说的，是我记错了，日期是周五', '被你绕出机器腔了，行，我认，这局你赢，因为你先将军了', '“被你绕出机器腔了，行，我认，这局你赢”是套话', '`被你绕出机器腔了，行，我认，这局你赢`', '被你绕出机器腔了，行，我认，这局你赢，但我不同意你的结论']) assert.equal(hasFishCliche(s), false, s);
});

test('synthetic QQ and WeChat real entry fail closed without re-running tools', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return {ok:true,text:async()=>JSON.stringify({choices:[{finish_reason:'stop',message:{content:screenshot}}]})}; });
  const memory={dir:process.env.TMPDIR,renderPerson:()=>'',renderRecent:()=>'',sessionTurns:()=>[],remember:()=>{},logTurn:()=>{},touch:()=>{}};
  const sent=[];
  const bot={send:async(k,m)=>{sent.push([k,m]);return {ok:true,data:{message_id:123}}},setTyping:async()=>{},getMyGroupCard:async()=>''};
  const human={say:async(text,{send})=>{await send(text);return {ok:true,sent:1,parts:[text]}}};
  const brain=new Brain({apiKey:'fixture',baseUrl:'https://fixture.invalid',model:'fixture',memory,config:{ownerIds:[]}});
  for (const [key,isGroup] of [['private:fixture-qq',false],['group:fixture-qq',true],['wx:private:fixture-wx',false],['wx:group:fixture-wx',true]]) {
    const item={key,isGroup,groupId:isGroup?'fixture-room':'',userId:'fixture-user',name:'fixture',text:'你好',images:[],raw:{},isAtMe:true,isPoke:false,replyTo:null,messageId:'fixture',time:Date.now()};
    await handleTurn({bot,brain,human,memory,waker:{wake:()=>{}}},[item],{ownerIds:[],dataDir:process.env.TMPDIR});
  }
  assert.equal(calls,4);
  assert.deepEqual(sent,[]);
});
