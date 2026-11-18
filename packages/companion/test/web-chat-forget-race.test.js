import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {handleTurn} from '../src/index.js';
import {Memory} from '../src/memory.js';
import {browseWebTopic,createWebScope} from '../src/web-living.js';
import {initializeManagedStore} from '../src/memory-brain-trust.js';
import {tiebaMessage} from './tieba-trusted-message-fixture.js';

for (const scenario of ['forget-first','send-first','normal']) test(`web turn coordinates ${scenario} across processes`, async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'web-turn-race-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const directory=path.join(dir,'memory-brain-scoped'); initializeManagedStore(directory);
 const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'};
 const cfg={ownerIds:['1'],dataDir:dir,memoryBrain:{enabled:true,trustedProcess:true,trustedScope:scope,authorizedSources:['web-source-page'],backend:'sqlite-fts'}};
 const topic='怪物猎人荒野',quote=`${topic}包含一个公开测试内容`, url='https://example.com/a';
 await browseWebTopic({topic,memory:{dir},webScope:createWebScope(cfg,dir),search:async()=>({success:true,text:`1. ${topic}相关介绍\n(来源: web ${url})`}),readEvidence:async()=>({url,text:quote}),brain:{complete:async({prompt})=>prompt.includes('想不想再花')?{deep:true}:prompt.includes('页面证据')?{relevant:true,quote}:prompt.includes('是否想把这段原文')?{interested:true}:{details:'摘要',mood:'看看'}}});
 let ready,release;const started=new Promise(r=>ready=r),gate=new Promise(r=>release=r);let sends=0;
 let sendStarted,finishSend;const sendEntered=new Promise(r=>sendStarted=r),sendGate=new Promise(r=>finishSend=r);
 const memory=new Memory({dir}); const turn=handleTurn({memory,brain:{reply:async p=>{assert.ok(p.situation.includes(quote));ready();await gate;return {text:'公开测试内容'};}},bot:{send:async()=>{sends++;sendStarted();if(scenario==='send-first')await sendGate;return {ok:true};},setTyping:async()=>{}},human:{say:async(parts,{send})=>{for(const p of parts){const result=await send(p);if(!result?.ok)return result;}return {ok:true,sent:parts.length,parts};}},waker:{wake(){}}},[await tiebaMessage()],cfg);
 await started;
 const mod=new URL('../src/memory-brain-trust.js',import.meta.url).href;
 const script=`import {createManagedMemoryBrain} from ${JSON.stringify(mod)};const scope=JSON.parse(process.argv[2]);const store=createManagedMemoryBrain({directory:process.argv[1],scope,sources:['web-source-page'],trustedProcess:true,backend:'sqlite-fts'});process.stdout.write('ready\\n');await store.forget(scope,{source:'web-source-page',evidence:process.argv[3]});`;
 if(scenario==='normal'){release();await turn;assert.equal(sends,1);return;}
 if(scenario==='send-first'){release();await sendEntered;}
 let forgotten=false, childReady; const childStarted=new Promise(r=>childReady=r);
 const forgetting=new Promise((resolve,reject)=>{const p=spawn(process.execPath,['--input-type=module','-e',script,directory,JSON.stringify(scope),url],{stdio:['ignore','pipe','inherit']});p.stdout.once('data',childReady);p.on('error',reject);p.on('exit',c=>{forgotten=true;c===0?resolve():reject(Error(`child ${c}`));});});
 if(scenario==='send-first'){await childStarted;await new Promise(r=>setTimeout(r,400));assert.equal(forgotten,false);finishSend();await turn;await forgetting;assert.equal(sends,1);}
 else {await forgetting;release();await turn;assert.equal(sends,0);}
});
