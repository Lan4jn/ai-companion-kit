import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {handleTurn} from '../src/index.js';
import {browseWebTopic, createWebScope} from '../src/web-living.js';
import {initializeManagedStore, createManagedMemoryBrain} from '../src/memory-brain-trust.js';
import {tiebaMessage} from './tieba-trusted-message-fixture.js';

test('authorized owner multi-message batch retains scoped web recall, without weakening authorization or forget', async t => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'memory-batch-auth-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'};
 const directory=path.join(dir,'memory-brain-scoped');
 initializeManagedStore(directory);
 const url='https://example.com/a', topic='怪物猎人荒野', quote=`${topic}包含一个公开测试内容`;
 const cfg={ownerIds:['1'],dataDir:dir,memoryBrain:{enabled:true,trustedProcess:true,trustedScope:scope,authorizedSources:['web-source-page']}};
 const webScope=createWebScope(cfg,dir);
 await browseWebTopic({topic,memory:{dir},webScope,search:async()=>({success:true,text:`1. ${topic}相关介绍\n(来源: web ${url})`}),readEvidence:async()=>({url,text:quote}),brain:{complete:async ({prompt})=>prompt.includes('想不想再花')?{deep:true,why:'想了解'}:prompt.includes('页面证据')?{relevant:true,quote}:prompt.includes('是否想把这段原文')?{interested:true}:{details:'摘要',mood:'看看'}}});
 async function turn(items){let prompt;await handleTurn({brain:{reply:async p=>{prompt=p;return {text:''}}},memory:{dir},bot:{},human:{},waker:{}},items,cfg);return prompt.situation;}
 const one=await tiebaMessage({id:123,text:'怪物猎人'}), two=await tiebaMessage({id:124,text:'荒野怎样'});
 assert.match(await turn([one]),/公开测试内容/);
 assert.match(await turn([one,two]),/公开测试内容/);
 const originalScope=cfg.memoryBrain.trustedScope;
 cfg.memoryBrain.trustedScope={...scope,user:'2'};
 assert.doesNotMatch(await turn([one,two]),/公开测试内容/);
 cfg.memoryBrain.trustedScope=originalScope;
 assert.doesNotMatch(await turn([{...one},two]),/公开测试内容/);
 assert.doesNotMatch(await turn([await tiebaMessage({userId:2,id:125}),two]),/公开测试内容/);
 const store=createManagedMemoryBrain({directory,scope,sources:['web-source-page'],trustedProcess:true});
 await store.revoke(scope,{source:'web-source-page'});
 assert.doesNotMatch(await turn([one,two]),/公开测试内容/);
});
