import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {browseWebTopic, createWebScope, collectGeneratedWebJournal, fetchTrendingTopics} from '../src/web-living.js';
import {initializeManagedStore} from '../src/memory-brain-trust.js';

test('ambiguous reviewer output cannot authorize an invented experience', async t => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'web-review-ambiguous-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 initializeManagedStore(path.join(dir,'memory-brain-scoped'));
 const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'};
 const cfg={dataDir:dir,ownerIds:['1'],memoryBrain:{enabled:true,backend:'sqlite-fts',trustedProcess:true,trustedScope:scope,authorizedSources:['web-source-page']}};
 const cap=createWebScope(cfg,dir), quote='Steam游戏包含一个公开测试内容';
 await browseWebTopic({topic:'Steam游戏',memory:{dir},webScope:cap,brain:{complete:async p=>{
  if(p.prompt.includes('想不想再花'))return {deep:true};
  if(p.prompt.includes('页面证据'))return {relevant:true,quote};
  if(p.prompt.includes('是否想把'))return {interested:true};
  if(p.prompt.includes('网页兴趣日记摘录'))return {quote,thought:'我昨天和朋友玩过这款游戏。'};
  if(p.prompt.includes('感想审查'))return {safe:true, reason:'其实包含虚构经历'};
  return {details:'摘要'};
 }},search:async()=>({success:true,text:'1. Steam游戏相关介绍\n(来源: web https://example.com/a)'}),readEvidence:async()=>({url:'https://example.com/a',text:quote})});
 const rows=await collectGeneratedWebJournal(dir,cap);
 assert.equal(rows.length,1); assert.equal(rows[0].display.thought,undefined);
});

test('trending network errors do not log sensitive exception text', async t => {
 const previousFetch=globalThis.fetch, previousLog=console.log;
 const logs=[]; t.after(()=>{globalThis.fetch=previousFetch; console.log=previousLog;});
 globalThis.fetch=async()=>{throw Error('secret-synthetic-token-XYZ');};
 console.log=(...args)=>logs.push(args.join(' '));
 await fetchTrendingTopics();
 assert.ok(!logs.join('\n').includes('secret-synthetic-token-XYZ'));
});
