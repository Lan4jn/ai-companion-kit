import test from 'node:test';
import assert from 'node:assert/strict';
import { Humanizer, CHAT_CAPACITY_NOTICE } from '../src/humanize.js';
import { handleTurn } from '../src/index.js';
import { Brain } from '../src/brain.js';

async function say(text, send=async()=>({ok:true})) {
 const seen=[]; const result=await new Humanizer({enabled:false,burstMax:9}).say(text,{send:async p=>{seen.push(p);return send(p,seen.length)}}); return {seen,result};
}
test('over-capacity answer is replaced before any original segment is sent', async () => {
 const {seen,result}=await say('甲'.repeat(3001)); assert.deepEqual(seen,[CHAT_CAPACITY_NOTICE]); assert.equal(result.capacityExceeded,true);
});
test('short and complete three segments preserve content',async()=>{
 assert.deepEqual((await say('你好。')).seen,['你好。']);
 const input='甲'.repeat(950)+'👨‍👩‍👧‍👦'+'乙'.repeat(950)+'[CQ:at,qq=123]'+'丙'.repeat(950);
 const {seen}=await say(input); assert.equal(seen.length,3); assert.equal(seen.join(''),input); assert.ok(seen.some(x=>x.includes('[CQ:at,qq=123]')));
});
test('oversized protected code and CQ are never partially sent',async()=>{
 for (const input of ['```js\n'+'x'.repeat(1100)+'\n```','[CQ:image,file='+ 'x'.repeat(1100)+']']) { const {seen,result}=await say(input); assert.deepEqual(seen,[]); assert.equal(result.ok,false); }
});
test('failed and unknown delivery never retries subsequent parts',async()=>{
 for(const outcome of ['permanent','unknown']) { const {seen,result}=await say(['one','two','three'],async(_,i)=>i===2?{ok:false,outcome}:{ok:true}); assert.deepEqual(seen,['one','two']); assert.equal(result.sent,1); }
});
async function entry(t, content, key, failAt=0) {
 t.mock.method(globalThis,'fetch',async()=>({ok:true,text:async()=>JSON.stringify({choices:[{finish_reason:'stop',message:{content}}]})}));
 const memory={renderPerson:()=>'',renderRecent:()=>'',sessionTurns:()=>[],remember:()=>{},logTurn:()=>{},touch:()=>{}};
 const brain=new Brain({apiKey:'fixture',memory}); const sent=[];
 const bot={send:async(k,m)=>{sent.push(m);return sent.length===failAt?{ok:false,outcome:'unknown'}:{ok:true,data:{message_id:123}}},setTyping:async()=>{},getMyGroupCard:async()=>''};
 const isGroup=key.includes('group:');
 const item={key,isGroup,groupId:isGroup?'42':'',userId:'42',name:'fixture',text:'请完整说明',images:[],raw:{},isAtMe:true,isPoke:false,replyTo:null,messageId:'fixture',time:Date.now()};
 const result=await handleTurn({bot,brain,human:new Humanizer({enabled:false}),memory,waker:{wake:()=>{}}},[item],{ownerIds:[],dataDir:process.env.TMPDIR});
 return {sent,result};
}
for (const key of ['private:342','group:42','wx:private:343']) {
 test(`real entry ${key}: three short parts and silent failure`,async t=>{
  const input='甲\n\n乙\n\n丙'; const first=await entry(t,input,key); assert.deepEqual(first.sent.map(s=>s.trim()),['甲','乙','丙']); t.mock.restoreAll();
  const over=await entry(t,'乙'.repeat(3001),key); assert.deepEqual(over.sent,[]);
 });
}
test('real entry stops at unknown second send',async t=>{const {sent,result}=await entry(t,'甲\n\n乙\n\n丙','private:342',2);assert.deepEqual(sent.map(s=>s.trim()),['甲','乙']);assert.equal(result.ok,false);});

for (const key of ['private:342','group:42','wx:private:343']) {
 test(`ordinary paragraphs are separate sends at ${key}`,async t=>{
  const first='煲仔饭好啊，锅巴是灵魂';
  const second='你可以试试腊味双拼';
  const {sent}=await entry(t,`${first}\n\n${second}`,key);
  assert.equal(sent.length,2); assert.deepEqual(sent.map(x=>x.trim()),[first,second]); assert.equal(sent.join(''),`${first}\n\n${second}`);
 });
}
