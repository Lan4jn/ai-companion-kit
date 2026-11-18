import test from 'node:test';
import assert from 'node:assert/strict';
import {Brain} from '../src/brain.js';
import {prepareConciseReply} from '../src/chat-concise-delivery.js';

const long='很长'.repeat(40);

test('real Brain tool turn carries scoped effective context into tool-free regeneration and reviews before release', async t => {
 const requests=[]; let searches=0;
 t.mock.method(globalThis,'fetch',async (_url,opts)=>{
   const p=JSON.parse(opts.body); requests.push(p);
   const n=requests.length;
   let message,finish_reason='stop';
   if(n===1){message={content:null,tool_calls:[{id:'call1',type:'function',function:{name:'web_search',arguments:JSON.stringify({query:'太阳系是什么'})}}]};finish_reason='tool_calls';}
   else if(n===2) message={content:long};
   else if(n<=7) message={content:long};
   else if(n===8) message={content:'答案简短。'};
   else message={content:'PASS'};
   const data={choices:[{finish_reason,message}]}; return {ok:true,text:async()=>JSON.stringify(data),json:async()=>data};
 });
 const brain=new Brain({apiKey:'synthetic',baseUrl:'http://offline.invalid',model:'fake',role:{build:({situation})=>'系统本轮证据:'+situation},memory:{}});
 brain.search=async()=>{searches++;return {success:true,text:'工具结果 https://example.invalid'}};
 const result=await brain.reply({key:'private:fixture',userId:'fixture',text:'太阳系是什么',history:[{text:'本会话历史',reply:'历史回应'}],situation:'本轮专属上下文',record:false,trapProbe:true});
 assert.equal(result.text,long);assert.equal(searches,1);
 const prepared=await prepareConciseReply(result.text,(d,f)=>brain.rewriteConciseDraft(d,f),(d,c)=>brain.verifyConciseDraft(d,c),{regenerate:d=>brain.regenerateConciseDraft(d,result.conciseContext)});
 assert.deepEqual(prepared.parts,['答案简短。']);assert.equal(searches,1);assert.equal(requests.length,9);
 const regen=requests[7]; assert.equal(regen.tools,undefined);assert.equal(regen.tool_choice,'none');
 const serialized=regen.messages[1].content;
 for(const value of ['本轮专属上下文','本会话历史','历史回应','太阳系是什么','web_search','工具结果']) assert.ok(serialized.includes(value),value);
 assert.equal(requests[8].tools,undefined);assert.equal(requests[8].tool_choice,'none');
});


test('multimodal regeneration refuses opaque image context without calling a text model', async t => {
 let calls=0; t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error('unexpected')});
 const brain=new Brain({apiKey:'synthetic',baseUrl:'http://offline.invalid',model:'fake',role:{build:()=>''},memory:{}});
 await assert.rejects(brain.regenerateConciseDraft(long,[{role:'user',content:[{type:'text',text:'这是什么'},{type:'image_url',image_url:{url:'data:image/jpeg;base64,ZmFrZQ=='}}]}]));
 assert.equal(calls,0);
});

test('overlapping real Brain scopes remain isolated through regeneration payloads', async t => {
 const requests=[];
 t.mock.method(globalThis,'fetch',async (_url,opts)=>{
  const p=JSON.parse(opts.body); requests.push(p); await new Promise(r=>setImmediate(r));
  const answer=p.tool_choice==='none'?'短答':long;
  const data={choices:[{finish_reason:'stop',message:{content:answer}}]};
  return {ok:true,text:async()=>JSON.stringify(data),json:async()=>data};
 });
 const brain=new Brain({apiKey:'synthetic',baseUrl:'http://offline.invalid',model:'fake',role:{build:({situation})=>situation},memory:{}});
 const run=async marker=>{
  const r=await brain.reply({key:'wx:private:'+marker,userId:marker,text:'提问'+marker,situation:'资料'+marker,history:[{text:'历史'+marker}],record:false,trapProbe:true});
  await brain.regenerateConciseDraft(r.text,r.conciseContext);
 };
 await Promise.all([run('SCOPE_ALPHA'),run('SCOPE_BETA')]);
 const payloads=requests.filter(r=>r.tool_choice==='none').map(r=>r.messages[1].content);
 assert.equal(payloads.length,2);
 for(const [own,other] of [['SCOPE_ALPHA','SCOPE_BETA'],['SCOPE_BETA','SCOPE_ALPHA']]) {
  const payload=payloads.find(p=>p.includes(own)); assert.ok(payload); assert.ok(!payload.includes(other));
  assert.ok(payload.includes('资料'+own)); assert.ok(payload.includes('历史'+own)); assert.ok(payload.includes('提问'+own));
 }
});
