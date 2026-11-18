import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {handleTurn} from '../src/index.js';
import {Memory} from '../src/memory.js';
import {Brain} from '../src/brain.js';
import {Role} from '../src/role.js';
import {Humanizer} from '../src/humanize.js';
import {loopGuard} from '../src/loop-guard.js';
import {browseWebTopic,createWebScope} from '../src/web-living.js';
import {initializeManagedStore} from '../src/memory-brain-trust.js';
import {tiebaMessage} from './tieba-trusted-message-fixture.js';

const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'};
const topic='怪物猎人荒野';
const urls=['https://example.com/a','https://example.com/b'];
const quotes=[`${topic}包含公开测试甲内容`,`${topic}包含公开测试乙内容`];
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
async function setup(t){
 loopGuard.state.clear();
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'web-brain-combo-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const directory=path.join(dir,'memory-brain-scoped');initializeManagedStore(directory);
 const cfg={ownerIds:['1'],dataDir:dir,memoryBrain:{enabled:true,trustedProcess:true,trustedScope:scope,authorizedSources:['web-source-page'],backend:'sqlite-fts'}};
 for(let i=0;i<2;i++) await browseWebTopic({topic,memory:{dir},webScope:createWebScope(cfg,dir),search:async()=>({success:true,text:`1. ${topic}相关介绍\n(来源: web ${urls[i]})`}),readEvidence:async()=>({url:urls[i],text:quotes[i]}),brain:{complete:async({prompt})=>prompt.includes('想不想再花')?{deep:true}:prompt.includes('页面证据')?{relevant:true,quote:quotes[i]}:prompt.includes('是否想把这段原文')?{interested:true}:{details:'摘要',mood:'看看'}}});
 const memory=new Memory({dir});const card=path.join(dir,'role.md');fs.writeFileSync(card,'Synthetic static persona.');
 const brain=new Brain({apiKey:'fixture',baseUrl:'https://model.invalid',model:'fixture',role:new Role({cardPath:card}),memory,dataDir:dir,ownerIds:['1']});
 return {dir,directory,cfg,memory,brain};
}
function forget(directory){
 const mod=new URL('../src/memory-brain-trust.js',import.meta.url).href;
 const script=`import {createManagedMemoryBrain} from ${JSON.stringify(mod)};const scope=JSON.parse(process.argv[2]);const store=createManagedMemoryBrain({directory:process.argv[1],scope,sources:['web-source-page'],trustedProcess:true,backend:'sqlite-fts'});process.stdout.write('ready\\n');await store.forget(scope,{source:'web-source-page',evidence:process.argv[3]});`;
 const ready=deferred(); const p=spawn(process.execPath,['--input-type=module','-e',script,directory,JSON.stringify(scope),urls[0]],{stdio:['ignore','pipe','pipe']});p.stdout.once('data',()=>ready.resolve());let err='';p.stderr.on('data',s=>err+=s); const done=new Promise((resolve,reject)=>{p.on('error',reject);p.on('exit',c=>c===0?resolve():reject(Error(`child ${c} ${err}`)));});return {ready:ready.promise,done};
}
function answer(message){const body={choices:[{message,finish_reason:message.tool_calls?'tool_calls':'stop'}]};return {ok:true,status:200,text:async()=>JSON.stringify(body),json:async()=>body};}
function deps(h,send){return {brain:h.brain,memory:h.memory,bot:{send,setTyping:async()=>{}},human:new Humanizer({enabled:false}),waker:{wake(){}}};}

test('real brain rejects forgotten mixed sources while cross-scope forged events cannot recall',async t=>{
 const h=await setup(t);let captured=[];let sends=0;const gate=deferred(),started=deferred();
 t.mock.method(globalThis,'fetch',async(_u,o)=>{const p=JSON.parse(o.body);captured.push(JSON.stringify(p.messages));started.resolve();await gate.promise;return answer({content:'公开测试甲乙内容'});});
 const item=await tiebaMessage();const turn=handleTurn(deps(h,async()=>{sends++;return {ok:true}}),[item],h.cfg);
 await started.promise;assert.ok(captured[0].includes(quotes[0]));assert.ok(captured[0].includes(quotes[1]));
 await forget(h.directory).done;gate.resolve();await turn;assert.equal(sends,0);
 captured=[];await handleTurn(deps(h,async()=>({ok:true})),[{...item}],h.cfg);assert.ok(captured.length);assert.ok(!captured[0].includes(quotes[0]));assert.ok(!captured[0].includes(quotes[1]));
 captured=[];loopGuard.state.clear();await handleTurn(deps(h,async()=>({ok:true})),[await tiebaMessage({id:124})],h.cfg);assert.ok(captured.length);assert.ok(!captured[0].includes(quotes[0]));assert.ok(captured[0].includes(quotes[1]));
});

test('real brain send holds cross-process forget lock through transport',async t=>{
 const h=await setup(t);const entered=deferred(),gate=deferred();let sends=0;
 t.mock.method(globalThis,'fetch',async()=>answer({content:'公开测试甲乙内容'}));
 const turn=handleTurn(deps(h,async()=>{sends++;entered.resolve();await gate.promise;return {ok:true}}),[await tiebaMessage()],h.cfg);
 await entered.promise;let finished=false;const f=forget(h.directory);f.done.then(()=>finished=true);await f.ready;await new Promise(r=>setTimeout(r,400));assert.equal(finished,false);gate.resolve();await turn;await f.done;assert.equal(sends,1);
});

for(const scenario of ['fifth-success','regenerate','too-long','four-parts','unknown']) test(`real brain concise ${scenario} with web provenance`,async t=>{
 const h=await setup(t);let generation=0,rewrites=0,reviews=0,regens=0,sends=0;const payloads=[];
 t.mock.method(globalThis,'fetch',async(_u,o)=>{const p=JSON.parse(o.body);payloads.push(p);const sys=p.messages[0].content;
  if(sys.includes('你只重新斟酌')){rewrites++;assert.equal(p.tool_choice,'none');return answer({content:scenario==='fifth-success'&&rewrites===5?'简短回答':''});}
  if(sys.includes('你是独立审校员')){reviews++;assert.equal(p.tool_choice,'none');return answer({content:'PASS'});}
  if(sys.includes('根据本轮上下文与已取得的工具结果')){regens++;assert.equal(p.tool_choice,'none');return answer({content:scenario==='regenerate'?'简短回答':scenario==='four-parts'?'甲\n\n乙\n\n丙\n\n丁':'长'.repeat(51)});}
  generation++;assert.ok(JSON.stringify(p.messages).includes(quotes[0]));assert.ok(JSON.stringify(p.messages).includes(quotes[1]));
  return answer({content:scenario==='unknown'?'第一段\n\n第二段\n\n第三段':'长'.repeat(51)});
 });
 const result=await handleTurn(deps(h,async()=>{sends++;return scenario==='unknown'?{ok:false,outcome:'unknown'}:{ok:true}}),[await tiebaMessage()],h.cfg);
 assert.equal(generation,1);
 if(scenario==='unknown'){assert.equal(sends,1);assert.equal(result.ok,false);assert.equal(rewrites,0);}
 else {assert.equal(rewrites,5);assert.equal(regens,scenario==='fifth-success'?0:1);assert.equal(sends,['fifth-success','regenerate'].includes(scenario)?1:0);assert.equal(reviews,['fifth-success','regenerate'].includes(scenario)?1:0);}
});

test('web provenance with real tool turn and tool-free regeneration does not repeat search',async t=>{
 const h=await setup(t);let searches=0,turns=0,rewrites=0,regens=0,sends=0;
 h.brain.search=async()=>{searches++;return {success:true,text:'工具结果 https://example.invalid'};};
 t.mock.method(globalThis,'fetch',async(_u,o)=>{const p=JSON.parse(o.body),sys=p.messages[0].content;
  if(sys.includes('你只重新斟酌')){rewrites++;assert.equal(p.tool_choice,'none');return answer({content:''});}
  if(sys.includes('你是独立审校员'))return answer({content:'PASS'});
  if(sys.includes('根据本轮上下文与已取得的工具结果')){regens++;assert.equal(p.tool_choice,'none');assert.equal(p.tools,undefined);assert.ok(p.messages[1].content.includes('工具结果'));assert.ok(p.messages[1].content.includes(quotes[0]));return answer({content:'太阳系简短回答'});}
  turns++;assert.ok(JSON.stringify(p.messages).includes(quotes[0]));
  return turns===1?answer({content:null,tool_calls:[{id:'s1',type:'function',function:{name:'web_search',arguments:JSON.stringify({query:'太阳系是什么'})}}]}):answer({content:'长'.repeat(51)});
 });
 await handleTurn(deps(h,async()=>{sends++;return {ok:true}}),[await tiebaMessage({text:'太阳系是什么'})],h.cfg);
 assert.equal(turns,2);assert.equal(searches,1);assert.equal(rewrites,5);assert.equal(regens,1);assert.equal(sends,1);
});
