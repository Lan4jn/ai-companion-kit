import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {handleTurn} from '../src/index.js';
import {browseWebTopic,createWebScope} from '../src/web-living.js';
import {initializeManagedStore} from '../src/memory-brain-trust.js';
import {tiebaMessage} from './tieba-trusted-message-fixture.js';

test('web page evidence reaches only the trusted owner private turn', async t => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'web-chat-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 initializeManagedStore(path.join(dir,'memory-brain-scoped'));
 const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'};
 const cfg={ownerIds:['1'],dataDir:dir,memoryBrain:{enabled:true,trustedProcess:true,trustedScope:scope,authorizedSources:['web-source-page'],backend:'sqlite-fts'}};
 const webScope=createWebScope(cfg,dir);
 const topic='怪物猎人荒野', quote=`${topic}包含一个公开测试内容`;
 await browseWebTopic({topic,memory:{dir},webScope,search:async()=>({success:true,text:`1. ${topic}相关介绍\n(来源: web https://example.com/a)`}),readEvidence:async()=>({url:'https://example.com/a',text:quote}),brain:{complete:async ({prompt})=>prompt.includes('想不想再花')?{deep:true,why:'想了解'}:prompt.includes('页面证据')?{relevant:true,quote}:prompt.includes('是否想把这段原文')?{interested:true}:{details:'摘要',mood:'看看'}}});
 async function turn(items){let captured;await handleTurn({brain:{reply:async p=>{captured=p;return {text:''}}},memory:{dir},bot:{},human:{},waker:{}},items,cfg);return captured.situation;}
 const owner=await tiebaMessage();
 const recalled=await turn([owner]);
 assert.match(recalled,/example\.com/); assert.ok(recalled.includes(quote)); assert.match(recalled,/未经独立核实/);
 assert.doesNotMatch(await turn([{...owner}]),/公开测试内容/);
 assert.doesNotMatch(await turn([await tiebaMessage({type:'group',groupId:9})]),/公开测试内容/);
 assert.doesNotMatch(await turn([await tiebaMessage({userId:2})]),/公开测试内容/);
 assert.doesNotMatch(await turn([await tiebaMessage({userId:2}),owner]),/公开测试内容/);
});
