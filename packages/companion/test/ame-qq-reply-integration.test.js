import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {register} from 'node:module';
import {OneBot} from '../src/transport-onebot.js';
import {handleTurn} from '../src/index.js';
import {initializeManagedStore,createManagedMemoryBrain} from '../src/memory-brain-trust.js';
register('./memory-brain-fake-ws-loader.js', import.meta.url);
const python=process.env.AME_TEST_PYTHON;

test('verified OneBot reply crosses QQ entry to AME exact transactional forget', {skip:!python,timeout:60000}, async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'ame-qq-reply-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const directory=path.join(dir,'memory-brain-scoped'); initializeManagedStore(directory);
 const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'},source='qq-private-message';
 const opts={directory,scope,sources:[source],trustedProcess:true,backend:'ame',python};
 const store=createManagedMemoryBrain(opts);
 const cfg={ownerIds:['1'],dataDir:dir,memoryBrain:{enabled:true,trustedProcess:true,trustedScope:scope,authorizedSources:[source],backend:'ame',python}};
 await store.remember(scope,{source,evidence:'onebot-message:123',text:'synthetic target'});
 await store.remember(scope,{source,evidence:'onebot-message:124',text:'synthetic survivor'});
 async function message({id='123',refUser=1,text='忘记这条聊天记忆'}={}) {
  let resolve;const got=new Promise(r=>resolve=r);const bot=new OneBot({wsUrl:'ws://fixture',onMessage:resolve});
  bot.api=async()=>({ok:true,data:{status:'ok',retcode:0,data:{self_id:99,message_type:'private',sub_type:'friend',message_id:Number(id),user_id:refUser,sender:{user_id:refUser},message:[{type:'text',data:{text:'合成旧消息'}}]}}});
  while(!bot.ws) await new Promise(r=>setTimeout(r,1));
  bot.ws.emit('open');
  bot.ws.emit('message',JSON.stringify({post_type:'message',self_id:99,message_type:'private',sub_type:'friend',user_id:1,message_id:500,message:[{type:'reply',data:{id}},{type:'text',data:{text}}],sender:{user_id:1}}));
  const result=await got;bot.close();return result;
 }
 async function run(msg,config=cfg){let sent='';await handleTurn({bot:{send:async(_k,s)=>{sent+=s;return {ok:true}}},memory:{dir},brain:{},human:{},waker:{}},[msg],config);return sent;}
 assert.match(await run(await message({refUser:2})),/没有删除/);
 assert.match(await run(await message(),{...cfg,memoryBrain:{...cfg.memoryBrain,authorizedSources:[]}}),/无法安全遗忘/);
 assert.deepEqual((await store.privateHistory(scope)).map(x=>x.evidence),['onebot-message:123','onebot-message:124']);
 const results=await Promise.all([run(await message()),run(await message())]);
 assert.equal(results.filter(s=>s.includes('已对当前QQ私聊')).length,1);
 assert.ok(results.some(s=>/没有找到|无法确认/.test(s)));
 assert.match(results.find(s=>s.includes('已对当前QQ私聊')),/备份.*其他副本.*持久队列/);
 assert.deepEqual((await store.privateHistory(scope)).map(x=>x.evidence),['onebot-message:124']);
 await assert.rejects(store.remember(scope,{source,evidence:'onebot-message:123',text:'synthetic target'}));
 await store.commitChatHistory(scope,{turnId:'merged',events:['onebot-message:125','onebot-message:126'],text:'synthetic merged',reply:'synthetic reply'});
 assert.match(await run(await message({id:'125'})),/合并/);
 assert.equal((await store.chatHistory(scope)).length,1);
 await store.commitChatHistory(scope,{turnId:'single',events:['onebot-message:127'],text:'synthetic single',reply:'synthetic reply'});
 assert.match(await run(await message({id:'127'})),/已对当前QQ私聊/);
 assert.deepEqual((await store.chatHistory(scope)).map(x=>x.turnId),['merged']);
 assert.deepEqual((await store.privateHistory(scope)).map(x=>x.evidence),['onebot-message:124']);
});
