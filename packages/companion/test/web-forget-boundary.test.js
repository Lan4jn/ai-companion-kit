import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {handleTurn} from '../src/index.js';
import {browseWebTopic,createWebScope} from '../src/web-living.js';
import {initializeManagedStore,createManagedMemoryBrain} from '../src/memory-brain-trust.js';
import {tiebaMessage} from './tieba-trusted-message-fixture.js';

test('forgotten page is excluded individually while another interest remains', async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'web-forget-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'};
 const directory=path.join(dir,'memory-brain-scoped'); initializeManagedStore(directory);
 const cfg={ownerIds:['1'],dataDir:dir,memoryBrain:{enabled:true,backend:'sqlite-fts',trustedProcess:true,trustedScope:scope,authorizedSources:['web-source-page']}};
 const webScope=createWebScope(cfg,dir);
 const urls=['https://example.com/forgotten','https://example.com/kept'];
 const topics=['怪物猎人荒野','怪物猎人荒野'];
 const quotes=[`${topics[0]}包含一段合成测试内容甲`,`${topics[1]}包含一段合成测试内容乙`];
 for(let i=0;i<2;i++) await browseWebTopic({topic:topics[i],memory:{dir},webScope,search:async()=>({success:true,text:`1. ${topics[i]}相关介绍\n(来源: web ${urls[i]})`}),readEvidence:async()=>({url:urls[i],text:quotes[i]}),brain:{complete:async({prompt})=>prompt.includes('想不想再花')?{deep:true,why:'想了解'}:prompt.includes('页面证据')?{relevant:true,quote:quotes[i]}:prompt.includes('作为自己的兴趣记录')?{interested:true}:{details:'摘要',mood:'看看'}}});
 const store=createManagedMemoryBrain({directory,scope,sources:['web-source-page'],trustedProcess:true,backend:'sqlite-fts'});
 await store.forget(scope,{source:'web-source-page',evidence:urls[0]});
 let captured;
 await handleTurn({brain:{reply:async p=>{captured=p;return {text:''}}},memory:{dir},bot:{},human:{},waker:{}},[await tiebaMessage()],{ownerIds:['1'],dataDir:dir,memoryBrain:{enabled:true,backend:'sqlite-fts',trustedProcess:true,trustedScope:scope,authorizedSources:['web-source-page']}});
 assert.ok(!captured.situation.includes(quotes[0]));
 assert.ok(captured.situation.includes(quotes[1]));
 for (const memoryBrain of [{enabled:false}, {enabled:true,backend:'sqlite-fts',trustedProcess:true,trustedScope:scope,authorizedSources:[]}]) {
  let result;
  await handleTurn({brain:{reply:async p=>{result=p;return {text:''}}},memory:{dir},bot:{},human:{},waker:{}},[await tiebaMessage()],{ownerIds:['1'],dataDir:dir,memoryBrain});
  assert.ok(!result.situation.includes(quotes[0]));
  assert.ok(!result.situation.includes(quotes[1]));
 }
});
