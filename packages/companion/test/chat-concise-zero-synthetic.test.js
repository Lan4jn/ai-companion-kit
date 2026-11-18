import test from 'node:test';
import assert from 'node:assert/strict';
import {handleTurn} from '../src/index.js';
import {Humanizer} from '../src/humanize.js';
import {prepareConciseReply,safeReplyParts,safeTransportMessage} from '../src/chat-concise-delivery.js';

const long='过长信息'.repeat(20);
async function run({group=false,reply={text:long},rewrite=async()=>long,verify=async()=>false,regenerate=async()=>long,sendResult={ok:true},platform='qq'}={}) {
 const sent=[], history=[], calls=[];
 const memory={renderPerson:()=>'',renderRecent:()=>'',sessionTurns:()=>[],remember:()=>{},logTurn:x=>history.push(x),touch:()=>{}};
 const brain={reply:async i=>{assert.equal(i.record,false);calls.push('reply');return reply},rewriteConciseDraft:async(...x)=>{calls.push('rewrite');return rewrite(...x)},verifyConciseDraft:async(...x)=>{calls.push('verify');return verify(...x)},regenerateConciseDraft:async(...x)=>{calls.push('regenerate');return regenerate(...x)}};
 const item={key:group?'group:123':'private:342',isGroup:group,userId:'42',name:'fixture',text:'说点什么',images:[],raw:{},isAtMe:true,isPoke:false,replyTo:null,messageId:'fixture',time:Date.now(),platform};
 const bot={send:async(_k,m)=>{sent.push(m);return sendResult},sendVoice:async(_k,m)=>{sent.push(m);return sendResult},setTyping:async()=>{}};
 await handleTurn({bot,brain,human:new Humanizer({enabled:false}),memory,waker:{wake:()=>{}}},[item],{ownerIds:[],dataDir:process.env.TMPDIR});
 return {sent,history,calls};
}
for (const [platform,group] of [['qq',false],['qq',true],['wechat',false],['wechat',true]]) {
 test(`${platform} ${group?'group':'private'} Unicode and multiline entry boundary`,async()=>{
  const good=await run({platform,group,reply:{text:'😀'.repeat(24)+'\n\n'+'鱼'.repeat(24)}});
  assert.equal([...good.sent.join('')].length,50); assert(good.sent.length<=3); assert.equal(good.history.length,1);
  const bad=await run({platform,group,reply:{text:'😀'.repeat(25)+'\n\n'+'鱼'.repeat(24)}});
  assert.deepEqual(bad.sent,[]); assert.deepEqual(bad.history,[]); assert.equal(bad.calls.filter(x=>x==='rewrite').length,5); assert.equal(bad.calls.filter(x=>x==='regenerate').length,1);
 });
}

test('边界与标记均按真实码点计算',()=>{assert(safeReplyParts(['😀'.repeat(50)]));assert(!safeReplyParts(['😀'.repeat(51)]));assert(!safeReplyParts(['a'.repeat(26),'b'.repeat(25)]));assert(!safeTransportMessage('[CQ:image,file='+ 'x'.repeat(60)+']'));assert(!safeTransportMessage('https://x/'+ 'a'.repeat(50)));assert(!safeTransportMessage('```'+ 'a'.repeat(50)+'```'));});
for(const group of [false,true]) test(`QQ ${group?'群':'私'}过长失败静默且无历史`,async()=>{const r=await run({group});assert.deepEqual(r.sent,[]);assert.deepEqual(r.history,[]);assert.equal(r.calls.filter(x=>x==='rewrite').length,5);assert.equal(r.calls.filter(x=>x==='regenerate').length,1);});
test('微信模拟入口短答正常发送并记录',async()=>{const r=await run({platform:'wechat',reply:{text:'好呀。'}});assert.deepEqual(r.sent,['好呀。']);assert.equal(r.history.length,1)});
test('重生仅获得本轮上下文且不重复工具',async()=>{const context=[{role:'user',content:'本轮问题'},{role:'tool',content:'本轮结果'}];let seen; const r=await run({reply:{text:long,conciseContext:context},regenerate:async(_draft,c)=>{seen=c;return '短答案'},verify:async()=>true});assert.deepEqual(seen,context);assert.deepEqual(r.sent,['短答案']);assert.equal(r.calls.filter(x=>x==='reply').length,1);assert.equal(r.calls.filter(x=>x==='rewrite').length,5);});
test('失败话术、超长语音、未知发送均不误记',async()=>{for(const reply of [{text:'兜底',reason:'incomplete_completion'},{text:'好',voiceB64:'fixture',voiceText:'长'.repeat(51)}]){const r=await run({reply});assert.deepEqual(r.sent,[]);assert.deepEqual(r.history,[])}const r=await run({reply:{text:'一\n\n二'},sendResult:{ok:false,outcome:'unknown'}});assert.equal(r.sent.length,1);assert.deepEqual(r.history,[])});
test('语音部分成功后文字回退不得超过三气泡',async()=>{
 const sent=[], history=[]; let voices=0;
 const memory={renderPerson:()=>'',renderRecent:()=>'',sessionTurns:()=>[],remember:()=>{},logTurn:x=>history.push(x),touch:()=>{}};
 const brain={reply:async()=>({text:'原文',voiceB64:'x',voiceChunks:[{base64:'a',spokenText:'甲甲甲'},{base64:'b',spokenText:'乙乙乙'},{base64:'c',spokenText:'丙丙丙\n\n丁丁丁\n\n戊戊戊'}]})};
 const bot={sendVoice:async(_k,m)=>{voices++;if(voices===3)return {ok:false,outcome:'permanent',sent:0}; sent.push(m);return {ok:true}},send:async(_k,m)=>{sent.push(m);return {ok:true}},setTyping:async()=>{}};
 const item={key:'private:342',isGroup:false,userId:'42',name:'fixture',text:'说点什么',images:[],raw:{},isAtMe:true,isPoke:false,replyTo:null,messageId:'fixture',time:Date.now()};
 await handleTurn({bot,brain,human:new Humanizer({enabled:false}),memory,waker:{wake:()=>{}}},[item],{ownerIds:[],dataDir:process.env.TMPDIR});
 assert(sent.length<=3, `sent ${sent.length} bubbles`);
});

test('重生不能绕过校验',async()=>{let count=0;let r=await prepareConciseReply(long,async()=>{count++;return long},async()=>false,{regenerate:async()=> '短答'});assert.equal(count,5);assert.deepEqual(r.parts,[]);});
