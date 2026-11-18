import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {browseWebTopic, collectWebKnowledge, collectWebJournal, createWebScope} from '../src/web-living.js';
import {initializeManagedStore} from '../src/memory-brain-trust.js';

test('trusted owner capability isolates shared directory and rejects untrusted identities', async t => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'web-identity-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 initializeManagedStore(path.join(dir,'memory-brain-scoped'));
 const config=user=>({dataDir:dir,ownerIds:[user],memoryBrain:{enabled:true,trustedProcess:true,trustedScope:{tenant:'companion',platform:'qq',type:'private',session:`private:${user}`,user},authorizedSources:['web-source-page']}});
 const a=createWebScope(config('1'),dir), b=createWebScope(config('2'),dir);
 assert.throws(()=>createWebScope({...config('1'),ownerIds:['2']},dir));
 const quote='Steam游戏包含一个公开测试内容';
 const browse=(scope,quote)=>browseWebTopic({topic:'Steam游戏',memory:{dir},webScope:scope,brain:{complete:async({prompt})=>prompt.includes('想不想再花')?{deep:true}:prompt.includes('页面证据')?{relevant:true,quote}:prompt.includes('是否想把')?{interested:true}:{details:'摘要',mood:'看看'}},search:async()=>({success:true,text:'1. Steam游戏相关介绍\n(来源: web https://example.com/a)'}),readEvidence:async()=>({url:'https://example.com/a',text:quote})});
 const quoteB='Steam游戏包含另一个独立测试内容';
 const results=await Promise.all([browse(a,quote),browse(b,quoteB)]);
 assert.deepEqual(results.map(r=>r.goalStatus),['completed','completed']);
 assert.equal(collectWebKnowledge(dir,a).length,1);
 assert.equal(collectWebKnowledge(dir,b).length,1);
 assert.equal(collectWebJournal(dir,a).length,1);
 assert.equal(collectWebJournal(dir,b).length,1);
 assert.equal(collectWebJournal(dir,a)[0].display.quote,quote);
 assert.equal(collectWebJournal(dir,b)[0].display.quote,quoteB);
 assert.deepEqual(collectWebKnowledge(dir,{}),[]);
 assert.deepEqual(collectWebJournal(dir,'private:1'),[]);
});
