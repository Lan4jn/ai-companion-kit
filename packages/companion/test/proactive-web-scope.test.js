import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {browseWebTopic,createWebScope,createProactiveWebContext} from '../src/web-living.js';
import {initializeManagedStore} from '../src/memory-brain-trust.js';
import {startProactive,stopProactive} from '../src/proactive.js';
import {spawn} from 'node:child_process';

test('trusted proactive web context is private-owner bound and requires revalidation', async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'proactive-web-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 initializeManagedStore(path.join(dir,'memory-brain-scoped'));
 const config=user=>({dataDir:dir,ownerIds:[user],memoryBrain:{enabled:true,trustedProcess:true,trustedScope:{tenant:'companion',platform:'qq',type:'private',session:`private:${user}`,user},authorizedSources:['web-source-page']}});
 const cfg=config('1'), scope=createWebScope(cfg,dir), quote='Steam游戏包含一个公开测试内容';
 await browseWebTopic({topic:'Steam游戏',memory:{dir},webScope:scope,brain:{complete:async({prompt})=>prompt.includes('想不想再花')?{deep:true}:prompt.includes('页面证据')?{relevant:true,quote}:prompt.includes('是否想把')?{interested:true}:{details:'摘要',mood:'看看'}},search:async()=>({success:true,text:'1. Steam游戏相关介绍\n(来源: web https://example.com/a)'}),readEvidence:async()=>({url:'https://example.com/a',text:quote})});
 const context=createProactiveWebContext(cfg,dir,'1');
 const snapshot=await context.snapshot(); assert.ok(snapshot.text.includes(quote));
 assert.equal((await createProactiveWebContext(config('2'),dir,'2').snapshot()).text,'');
 assert.throws(()=>createProactiveWebContext(cfg,dir,'2'));
 let sent=0; await snapshot.send(()=>{sent++; return {ok:true};}); assert.equal(sent,1);
});

for (const scenario of ['forget-first','send-first','unknown']) test(`proactive web ${scenario} coordinates actual entry`, async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'proactive-race-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const directory=path.join(dir,'memory-brain-scoped'); initializeManagedStore(directory);
 const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'};
 const cfg={ownerIds:['1'],dataDir:dir,memoryBrain:{enabled:true,trustedProcess:true,trustedScope:scope,authorizedSources:['web-source-page'],backend:'sqlite-fts'}};
 const quote='Steam游戏包含一个公开测试内容', url='https://example.com/a';
 await browseWebTopic({topic:'Steam游戏',memory:{dir},webScope:createWebScope(cfg,dir),search:async()=>({success:true,text:`1. Steam游戏相关介绍\n(来源: web ${url})`}),readEvidence:async()=>({url,text:quote}),brain:{complete:async({prompt})=>prompt.includes('想不想再花')?{deep:true}:prompt.includes('页面证据')?{relevant:true,quote}:prompt.includes('是否想把')?{interested:true}:{details:'摘要',mood:'看看'}}});
 let ready,release; const started=new Promise(r=>ready=r), gate=new Promise(r=>release=r); let sendReady,finish; const entering=new Promise(r=>sendReady=r), sendGate=new Promise(r=>finish=r); let sends=0;
 startProactive({ownerId:'1',webContext:createProactiveWebContext(cfg,dir,'1'),memory:{sessionTurns:()=>[],logTurn:()=>{}},brain:{reply:async p=>{assert.ok(p.text.includes(quote));ready();await gate;return {text:'{"want":true,"target":"dad","text":"公开测试内容"}'};}},bot:{send:async(key)=>{assert.equal(key,'private:1');sends++;sendReady();if(scenario==='send-first')await sendGate;return scenario==='unknown'?{outcome:'unknown'}:{ok:true};}},initialDelayMs:0,minGapMs:999999,activeStart:0,activeEnd:0});
 t.after(async()=>{try { await stopProactive(); } catch {}}); await started;
 if(scenario==='unknown'){release();await entering;await assert.rejects(stopProactive(),/未知/);assert.equal(sends,1);return;}
 const mod=new URL('../src/memory-brain-trust.js',import.meta.url).href;
 const script=`import {createManagedMemoryBrain} from ${JSON.stringify(mod)};const s=JSON.parse(process.argv[2]);const store=createManagedMemoryBrain({directory:process.argv[1],scope:s,sources:['web-source-page'],trustedProcess:true,backend:'sqlite-fts'});process.stdout.write('ready\\n');await store.forget(s,{source:'web-source-page',evidence:process.argv[3]});`;
 if(scenario==='send-first'){release();await entering;}
 let done=false, childReady; const childStarted=new Promise(r=>childReady=r);
 const forgetting=new Promise((resolve,reject)=>{const p=spawn(process.execPath,['--input-type=module','-e',script,directory,JSON.stringify(scope),url],{stdio:['ignore','pipe','inherit']});p.stdout.once('data',childReady);p.on('error',reject);p.on('exit',c=>{done=true;c===0?resolve():reject(Error(`child ${c}`));});});
 if(scenario==='send-first'){await childStarted;await new Promise(r=>setTimeout(r,300));assert.equal(done,false);finish();await forgetting;await stopProactive();assert.equal(sends,1);}
 else {await forgetting;release();await new Promise(r=>setTimeout(r,500));await stopProactive();assert.equal(sends,0);}
});
