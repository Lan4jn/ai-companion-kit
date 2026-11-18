import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {WeChatTransport} from '../src/transport-wechat.js';
import {handleTurn} from '../src/index.js';
import {Humanizer} from '../src/humanize.js';
import {Brain} from '../src/brain.js';
import {createLocalDurableBrainGenerator} from '../src/chat-onebot-queue-bridge.js';

const long='很长的内容'.repeat(20);

test('actual WeChat webhook and transport: failed reply is silent, short reply records once',async t=>{
 const probe=http.createServer(); probe.listen(0,'127.0.0.1'); await once(probe,'listening'); const port=probe.address().port; await new Promise(r=>probe.close(r));
 const sent=[],history=[],tasks=[]; let n=0;
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  if(String(url).endsWith('/api/GetSelfWXID')) return {ok:true,json:async()=>({code:1,data:{wx_id:'fixture-self'}})};
  if(String(url).endsWith('/api/SetMessageCallbackUrl')) return {ok:true,json:async()=>({code:1})};
  assert.match(String(url),/\/api\/SendTxt$/); sent.push(JSON.parse(options.body)); return {ok:true,json:async()=>({code:1})};
 });
 const memory={renderPerson:()=>'',renderRecent:()=>'',sessionTurns:()=>[],remember:()=>{},logTurn:x=>history.push(x),touch:()=>{}};
 const brain={reply:async()=>++n===1?{text:'兜底',reason:'incomplete_completion'}:{text:'好呀'},rewriteConciseDraft:async()=>long,verifyConciseDraft:async()=>false};
 const wx=new WeChatTransport({callbackPort:port,onMessage:item=>tasks.push(handleTurn({bot:wx,brain,human:new Humanizer({enabled:false}),memory,waker:{wake:()=>{}}},[item],{ownerIds:[],dataDir:process.env.TMPDIR}))});
 await wx.start(); await once(wx.server,'listening');
 t.after(()=>new Promise(resolve=>wx.server.close(resolve)));
 async function post(message_id){await new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port,method:'POST',path:'/wechat/callback'},res=>{res.resume();res.on('end',resolve)});req.on('error',reject);req.end(JSON.stringify({data:{wx_id:'fixture-user',content:'你好',message_id}}));}); await tasks.at(-1);}
 await post('1'); assert.equal(sent.length,0); assert.equal(history.length,0);
 await post('2'); assert.equal(sent.length,1); assert.equal(sent[0].msg,'好呀'); assert.equal(history.length,1);
 assert.equal((await wx.send('wx:private:fixture-user','x'.repeat(51))).ok,false); assert.equal(sent.length,1);
});

test('concurrent scopes retain only their own turn context for regeneration',async()=>{
 const seen=[],sent=[],history=[];
 const memory={renderPerson:()=>'',renderRecent:()=>'',sessionTurns:()=>[],remember:()=>{},logTurn:x=>history.push(x),touch:()=>{}};
 const brain={reply:async({key})=>({text:long,conciseContext:[{role:'user',content:key},{role:'tool',content:`result:${key}`}]}),rewriteConciseDraft:async()=>long,verifyConciseDraft:async()=>true,regenerateConciseDraft:async(_d,c)=>{seen.push(c);await new Promise(r=>setImmediate(r));return '短答'}};
 const bot={send:async(k,m)=>{sent.push([k,m]);return {ok:true}},setTyping:async()=>{}};
 const make=key=>({key,isGroup:key.startsWith('group:'),groupId:'1',userId:'42',name:'fixture',text:'你好',images:[],raw:{},isAtMe:true,isPoke:false,replyTo:null,messageId:key,time:Date.now()});
 await Promise.all(['private:42','group:1'].map(key=>handleTurn({bot,brain,human:new Humanizer({enabled:false}),memory,waker:{wake:()=>{}}},[make(key)],{ownerIds:[],dataDir:process.env.TMPDIR})));
 assert.equal(seen.length,2); for(const c of seen) assert.equal(c[1].content,`result:${c[0].content}`);
 assert.deepEqual(new Set(sent.map(([k])=>k)),new Set(['private:42','group:1'])); assert.equal(history.length,2);
});

test('durable regeneration has no repeated generation and fails closed on bad review',async t=>{
 const brain=new Brain({apiKey:'fixture',ownerIds:['123'],role:{buildDurablePersona:()=> 'fixture'},memory:{}}); let generated=0,rewrites=0,contexts=[];
 brain.generateDurableTextCandidate=async()=>{generated++;return [long]};
 brain.rewriteConciseDraft=async()=>{rewrites++;return long};
 brain.regenerateConciseDraft=async(_d,c)=>{contexts.push(c);return '短答'};
 brain.verifyConciseDraft=async()=>true;
 t.mock.method(console,'warn',()=>{});
 const run=createLocalDurableBrainGenerator({brain,ownerId:'123',trustLocalCard:true});
 assert.deepEqual(await run([{text:'仅本轮信息'}]),['短答']); assert.equal(generated,1); assert.equal(rewrites,5); assert.deepEqual(contexts,[[{role:'user',content:'仅本轮信息'}]]);
 brain.verifyConciseDraft=async()=>false;
 await assert.rejects(run([{text:'另一轮信息'}]),/concise failed/); assert.equal(generated,2); assert.equal(rewrites,10); assert.deepEqual(contexts[1],[{role:'user',content:'另一轮信息'}]);
});
