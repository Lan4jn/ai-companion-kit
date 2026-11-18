import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {handleTurn} from '../src/index.js';
import {tiebaMessage} from './tieba-trusted-message-fixture.js';
import {startScopedSend} from '../src/chat-forget-coordination.js';
import {initializeManagedStore,createManagedMemoryBrain} from '../src/memory-brain-trust.js';

const python=process.env.AME_TEST_PYTHON;
test('AME trusted QQ entry forgets only the unique specified message', {skip:!python,timeout:60000}, async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'ame-exact-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const directory=path.join(dir,'memory-brain-scoped'); initializeManagedStore(directory);
 const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'};
 const options={directory,scope,sources:['qq-private-message'],trustedProcess:true,backend:'ame',python};
 const store=createManagedMemoryBrain(options), source='qq-private-message';
 const legacy=createManagedMemoryBrain({...options,backend:'legacy',python:'/usr/bin/python3'});
 await legacy.remember(scope,{source,evidence:'onebot-message:123',text:'legacy copy'});
 await store.remember(scope,{source,evidence:'onebot-message:123',text:'synthetic apple'});
 await store.remember(scope,{source,evidence:'onebot-message:124',text:'synthetic pear'});
 const sent=[]; const deps={bot:{send:async(_k,s)=>{sent.push(s);return {ok:true}}},memory:{dir},brain:{},human:{},waker:{}};
 const cfg={ownerIds:['1'],dataDir:dir,memoryBrain:{enabled:true,trustedProcess:true,trustedScope:scope,authorizedSources:[source],backend:'ame',python}};
 await handleTurn(deps,[await tiebaMessage({text:'忘记这条聊天记忆：消息ID 123',id:500})],cfg);
 assert.match(sent.join(''),/已对当前QQ私聊/);
 assert.deepEqual((await store.privateHistory(scope)).map(x=>x.evidence),['onebot-message:124']);
 await assert.rejects(store.remember(scope,{source,evidence:'onebot-message:123',text:'synthetic apple'}));
 const run=async(text,userId=1,type='private',config=cfg)=>{sent.length=0; await handleTurn(deps,[await tiebaMessage({text,userId,type,groupId:type==='group'?9:undefined,id:501})],config); return sent.join('');};
 assert.match(await run('忘记这条聊天记忆：消息ID 124',2),/没有删除/);
 assert.match(await run('忘记这条聊天记忆：消息ID 124',1,'group'),/没有删除/);
 assert.match(await run('忘记这条聊天记忆：消息ID 999'),/没有找到/);
 assert.match(await run('忘记这条聊天记忆：消息ID 124',1,'private',{...cfg,memoryBrain:{...cfg.memoryBrain,authorizedSources:[]}}),/无法安全遗忘/);
 const manager=createManagedMemoryBrain({...options,management:true});
 await assert.rejects(manager.forget({context:scope,source,evidence:'onebot-message:999',exactSingle:true}));
 await store.commitChatHistory(scope,{turnId:'merged',events:['onebot-message:125','onebot-message:126'],text:'synthetic',reply:'reply'});
 await assert.rejects(manager.forget({context:scope,source,evidence:'onebot-message:125',exactSingle:true}));
 assert.match(await run('忘记这条聊天记忆：消息ID 125'),/合并/);
 let release,ready; const gate=new Promise(r=>release=r), started=new Promise(r=>ready=r);
 const active=startScopedSend(directory,scope,source,()=>true,async()=>{ready();await gate}); await started;
 try { assert.match(await run('忘记这条聊天记忆：消息ID 124'),/超时|无法确认/); } finally {release();await active;}
 assert.equal((await store.privateHistory(scope)).length,1);
 await store.commitChatHistory(scope,{turnId:'double',events:['onebot-message:124'],text:'synthetic',reply:'reply'});
 await assert.rejects(manager.forget({context:scope,source,evidence:'onebot-message:124',exactSingle:true}));
 assert.equal((await store.privateHistory(scope)).length,1);
 assert.deepEqual(await legacy.filterCandidates(scope,{candidates:[{source,evidence:'onebot-message:123',text:'legacy copy'}]}),[]);
});

test('AME exact forget concurrent attempts cannot remove another target', {skip:!python,timeout:60000},async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'ame-exact-race-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const directory=path.join(dir,'memory-brain-scoped');initializeManagedStore(directory);
 const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'},source='qq-private-message';
 const options={directory,scope,sources:[source],trustedProcess:true,backend:'ame',python};
 const store=createManagedMemoryBrain(options), manager=createManagedMemoryBrain({...options,management:true});
 for(const id of ['1','2']) await store.remember(scope,{source,evidence:`onebot-message:${id}`,text:`synthetic ${id}`});
 const input={context:scope,source,evidence:'onebot-message:1',exactSingle:true};
 const results=await Promise.allSettled([manager.forget(input),manager.forget(input)]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
 assert.deepEqual((await store.privateHistory(scope)).map(x=>x.evidence),['onebot-message:2']);
 await assert.rejects(store.remember(scope,{source,evidence:'onebot-message:1',text:'synthetic 1'}));
});
