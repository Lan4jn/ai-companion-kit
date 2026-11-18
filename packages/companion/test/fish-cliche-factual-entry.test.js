import test from 'node:test';
import assert from 'node:assert/strict';
import {handleTurn} from '../src/index.js';
import {Brain} from '../src/brain.js';
import {Humanizer} from '../src/humanize.js';

test('real handleTurn delivers original factual answer once for QQ and WeChat',async t=>{
 let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return {ok:true,text:async()=>JSON.stringify({choices:[{finish_reason:'stop',message:{content:'这条我认。报价 500 元（含税），保修三年。'}}]})}});
 const memory={renderPerson:()=>'',renderRecent:()=>'',sessionTurns:()=>[],remember:()=>{},logTurn:()=>{},touch:()=>{}};
 const brain=new Brain({apiKey:'fixture',baseUrl:'https://fixture.invalid',model:'fixture',role:{build:()=>''},memory});
 const sent=[]; const bot={send:async(k,m)=>{sent.push([k,m]);return {ok:true,data:{message_id:123}}},setTyping:async()=>{},getMyGroupCard:async()=>''};
 const human=new Humanizer({enabled:false});
 for(const key of ['private:42','group:42','wx:private:fake','wx:group:fake']){
  const isGroup=key.includes('group:');const item={key,isGroup,groupId:isGroup?'42':'',userId:'42',name:'fixture',text:'请解释报价',images:[],raw:{},isAtMe:true,isPoke:false,replyTo:null,messageId:'fixture',time:Date.now()};
  await handleTurn({bot,brain,human,memory,waker:{wake:()=>{}}},[item],{ownerIds:[],dataDir:process.env.TMPDIR});
 }
 assert.deepEqual(sent.map(x=>x[1]),Array(4).fill('这条我认。报价 500 元（含税），保修三年。'));assert.equal(calls,4);
});
