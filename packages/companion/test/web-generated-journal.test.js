import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {browseWebTopic, createWebScope, collectGeneratedWebJournal} from '../src/web-living.js';
import {initializeManagedStore, createManagedMemoryBrain} from '../src/memory-brain-trust.js';

test('generated scoped journal uses only authenticated evidence and rechecks forget', async t => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'web-generated-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 initializeManagedStore(path.join(dir,'memory-brain-scoped'));
 const cfg=user=>({dataDir:dir,ownerIds:[user],memoryBrain:{enabled:true,backend:'sqlite-fts',trustedProcess:true,trustedScope:{tenant:'companion',platform:'qq',type:'private',session:`private:${user}`,user},authorizedSources:['web-source-page']}});
 const a=cfg('1'),b=cfg('2'),sa=createWebScope(a,dir),sb=createWebScope(b,dir);
 const quotes=['Steam游戏包含一个公开测试内容','Steam游戏包含另一个独立测试内容'];
 const calls=[];
 await Promise.all([sa,sb].map((scope,i)=>browseWebTopic({topic:'Steam游戏',memory:{dir},webScope:scope,brain:{complete:async p=>{if(p.prompt.includes('想不想再花')) return {deep:true};if(p.prompt.includes('页面证据')) return {relevant:true,quote:quotes[i]};if(p.prompt.includes('是否想把'))return {interested:true};if(p.prompt.includes('感想审查'))return {safe:true};if(p.prompt.includes('网页兴趣日记摘录')){calls.push(p.prompt);return {quote:quotes[i],thought:i===0?'我觉得这个点挺有意思。':'我对这个内容有点好奇。'}}return {details:'摘要',mood:'看看'}}},search:async()=>({success:true,text:`1. Steam游戏相关介绍\n(来源: web https://example.com/${i})`}),readEvidence:async()=>({url:`https://example.com/${i}`,text:quotes[i]})})));
 assert.equal(calls.length,2);
 assert.ok(calls.every((x,i)=>quotes.filter(q=>x.includes(q)).length===1));
 const ja=await collectGeneratedWebJournal(dir,sa),jb=await collectGeneratedWebJournal(dir,sb);
 assert.equal(ja.length,1); assert.equal(jb.length,1);
 assert.equal(ja[0].display.quote,quotes[0]); assert.equal(jb[0].display.quote,quotes[1]);
 assert.equal(ja[0].display.thought,'我觉得这个点挺有意思。'); assert.equal(jb[0].display.thought,'我对这个内容有点好奇。');
 assert.deepEqual(ja[0].dependencies,['https://example.com/0']);
 assert.deepEqual(await collectGeneratedWebJournal(dir,{}),[]);
 const store=createManagedMemoryBrain({directory:path.join(dir,'memory-brain-scoped'),scope:a.memoryBrain.trustedScope,sources:['web-source-page'],trustedProcess:true,backend:'sqlite-fts'});
 await store.forget(a.memoryBrain.trustedScope,{source:'web-source-page',evidence:'https://example.com/0'});
 assert.deepEqual(await collectGeneratedWebJournal(dir,createWebScope(a,dir)),[]);
 assert.equal((await collectGeneratedWebJournal(dir,createWebScope(b,dir))).length,1);
 const script=`import assert from 'node:assert/strict'; import {createWebScope,collectGeneratedWebJournal} from './src/web-living.js'; import {handleTurn} from './src/index.js'; import {tiebaMessage} from './test/tieba-trusted-message-fixture.js'; const dir=process.env.DIR; const cfg=JSON.parse(process.env.CFG); for(const [u,n] of [['1',0],['2',1]]) {const c={...cfg,ownerIds:[u],memoryBrain:{...cfg.memoryBrain,trustedScope:{...cfg.memoryBrain.trustedScope,user:u,session:'private:'+u}}}; assert.equal((await collectGeneratedWebJournal(dir,createWebScope(c,dir))).length,n);} let seen=''; await handleTurn({brain:{reply:async p=>(seen=p.situation,{text:''})},memory:{dir},bot:{},human:{},waker:{}},[await tiebaMessage()],cfg); assert.ok(!seen.includes('公开测试内容')); console.log('RESTART_OK');`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:process.cwd(),encoding:'utf8',env:{...process.env,DIR:dir,CFG:JSON.stringify(a)},timeout:30000});
 assert.equal(child.status,0,child.stderr+child.stdout); assert.match(child.stdout,/RESTART_OK/);
});

test('model cannot introduce invented words into the scoped journal', async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'web-generated-invalid-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true})); initializeManagedStore(path.join(dir,'memory-brain-scoped'));
 const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'}, cfg={dataDir:dir,ownerIds:['1'],memoryBrain:{enabled:true,backend:'sqlite-fts',trustedProcess:true,trustedScope:scope,authorizedSources:['web-source-page']}};
 const cap=createWebScope(cfg,dir), quote='Steam游戏包含一个公开测试内容';
 await browseWebTopic({topic:'Steam游戏',memory:{dir},webScope:cap,brain:{complete:async p=>p.prompt.includes('想不想再花')?{deep:true}:p.prompt.includes('页面证据')?{relevant:true,quote}:p.prompt.includes('是否想把')?{interested:true}:p.prompt.includes('网页兴趣日记摘录')?{quote:'Steam游戏已经推出未读的续作'}:{details:'摘要'}},search:async()=>({success:true,text:'1. Steam游戏相关介绍\n(来源: web https://example.com/a)'}),readEvidence:async()=>({url:'https://example.com/a',text:quote})});
 assert.deepEqual(await collectGeneratedWebJournal(dir,cap),[]);
});


test('review failure falls back to quote; unsigned or modified entries never recall', async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'web-review-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true})); initializeManagedStore(path.join(dir,'memory-brain-scoped'));
 const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'}, cfg={dataDir:dir,ownerIds:['1'],memoryBrain:{enabled:true,backend:'sqlite-fts',trustedProcess:true,trustedScope:scope,authorizedSources:['web-source-page']}};
 const cap=createWebScope(cfg,dir), quote='Steam游戏包含一个公开测试内容';
 await browseWebTopic({topic:'Steam游戏',memory:{dir},webScope:cap,brain:{complete:async p=>{if(p.prompt.includes('想不想再花'))return {deep:true};if(p.prompt.includes('页面证据'))return {relevant:true,quote};if(p.prompt.includes('是否想把'))return {interested:true};if(p.prompt.includes('网页兴趣日记摘录'))return {quote,thought:'我昨天和朋友玩过这款游戏。'};if(p.prompt.includes('感想审查'))throw Error('model unavailable');return {details:'摘要'};}},search:async()=>({success:true,text:'1. Steam游戏相关介绍\n(来源: web https://example.com/a)'}),readEvidence:async()=>({url:'https://example.com/a',text:quote})});
 const rows=await collectGeneratedWebJournal(dir,cap); assert.equal(rows.length,1); assert.equal(rows[0].display.thought,undefined);
 const partition=fs.readdirSync(path.join(dir,'web-scoped'))[0], journal=path.join(dir,'web-scoped',partition,'web-journal-generated');
 const file=path.join(journal,fs.readdirSync(journal)[0]), envelope=JSON.parse(fs.readFileSync(file));
 envelope.payload.thought='我觉得很好奇。'; fs.writeFileSync(file,JSON.stringify(envelope)); assert.deepEqual(await collectGeneratedWebJournal(dir,cap),[]);
 fs.writeFileSync(file,JSON.stringify({version:1,goalId:envelope.payload.goalId,quote,dependencies:envelope.payload.dependencies})); assert.deepEqual(await collectGeneratedWebJournal(dir,cap),[]);
 fs.writeFileSync(file,'{"payload":'); assert.deepEqual(await collectGeneratedWebJournal(dir,cap),[]);
});

test('forget during model review prevents generated entry', async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'web-forget-race-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true})); initializeManagedStore(path.join(dir,'memory-brain-scoped'));
 const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'}, cfg={dataDir:dir,ownerIds:['1'],memoryBrain:{enabled:true,backend:'sqlite-fts',trustedProcess:true,trustedScope:scope,authorizedSources:['web-source-page']}};
 const cap=createWebScope(cfg,dir), quote='Steam游戏包含一个公开测试内容', url='https://example.com/a';
 const store=createManagedMemoryBrain({directory:path.join(dir,'memory-brain-scoped'),scope,sources:['web-source-page'],trustedProcess:true,backend:'sqlite-fts'}); let reviewed=false;
 await browseWebTopic({topic:'Steam游戏',memory:{dir},webScope:cap,brain:{complete:async p=>{if(p.prompt.includes('想不想再花'))return {deep:true};if(p.prompt.includes('页面证据'))return {relevant:true,quote};if(p.prompt.includes('是否想把'))return {interested:true};if(p.prompt.includes('网页兴趣日记摘录'))return {quote,thought:'我有点好奇。'};if(p.prompt.includes('感想审查')){reviewed=true;await store.forget(scope,{source:'web-source-page',evidence:url});return {safe:true};}return {details:'摘要'};}},search:async()=>({success:true,text:'1. Steam游戏相关介绍\n(来源: web https://example.com/a)'}),readEvidence:async()=>({url,text:quote})});
 assert.equal(reviewed,true); assert.deepEqual(await collectGeneratedWebJournal(dir,cap),[]);
});
