import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {register} from 'node:module';
import {OneBot} from '../src/transport-onebot.js';
import {handleTurn} from '../src/index.js';
import {initializeManagedStore,createManagedMemoryBrain} from '../src/memory-brain-trust.js';
register('./memory-brain-fake-ws-loader.js', import.meta.url);

test('owner reply forgets only a verified own private message',async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'reply-forget-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const directory=path.join(dir,'memory-brain-scoped'); initializeManagedStore(directory);
 const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'};
 const store=createManagedMemoryBrain({directory,scope,sources:['qq-private-message'],trustedProcess:true,backend:'sqlite-fts'});
 const cfg={ownerIds:['1'],dataDir:dir,memoryBrain:{enabled:true,backend:'sqlite-fts',trustedProcess:true,trustedScope:scope,authorizedSources:['qq-private-message']}};
 const sent=[];
 const run=async({ref={message_type:'private',sub_type:'friend',message_id:123,user_id:1,sender:{user_id:1},message:[{type:'text',data:{text:'旧消息'}}]}, segments=[{type:'reply',data:{id:'123'}},{type:'text',data:{text:'忘记这条聊天记忆'}}],user=1,type='private'}={})=>{
  let resolve;const got=new Promise(r=>resolve=r);const bot=new OneBot({wsUrl:'ws://fixture',onMessage:resolve});
  bot.api=async()=>({ok:true,data:{status:'ok',retcode:0,data:{self_id:99,...ref}}});bot.getMyGroupCard=async()=>'';
  while(!bot.ws) await new Promise(r=>setTimeout(r,1));
  bot.ws.emit('open');
  bot.ws.emit('message',JSON.stringify({post_type:'message',self_id:99,message_type:type,sub_type:type==='private'?'friend':'normal',user_id:user,group_id:type==='group'?9:undefined,message_id:500,message:segments,sender:{user_id:user}}));
  const msg=await got;bot.close();sent.length=0;
  await handleTurn({bot:{send:async(_k,s)=>{sent.push(s);return {ok:true}}},memory:{dir},brain:{},human:{},waker:{}},[msg],cfg);
  return sent.join('');
 };
 await store.remember(scope,{text:'合成旧消息',source:'qq-private-message',evidence:'onebot-message:123'});
 for(const ref of [
  {message_type:'group',sub_type:'friend',group_id:9,message_id:123,user_id:1,sender:{user_id:1}},
  {message_type:'private',sub_type:'friend',message_id:123,user_id:2,sender:{user_id:2}},
  {message_type:'private',sub_type:'friend',message_id:124,user_id:1,sender:{user_id:1}},
  {message_type:'private',sub_type:'friend',message_id:123,sender:{user_id:1}},
  {message_type:'private',sub_type:'group',message_id:123,user_id:1,sender:{user_id:1}},
  {message_type:'private',sub_type:'friend',message_id:123,user_id:1,sender:{user_id:1,group_id:9}},
 ]) {assert.match(await run({ref}),/没有删除/);assert.equal((await store.privateHistory(scope)).length,1);}
 assert.match(await run({segments:[{type:'text',data:{text:'[CQ:reply,id=123]忘记这条聊天记忆'}}]}),/没有删除/);
 assert.match(await run({segments:[{type:'reply',data:{id:'123'}},{type:'reply',data:{id:'123'}},{type:'text',data:{text:'忘记这条聊天记忆'}}]}),/没有删除/);
 assert.match(await run({segments:[{type:'reply',data:{id:'0123'}},{type:'text',data:{text:'忘记这条聊天记忆'}}]}),/没有删除/);
 assert.match(await run({user:2}),/没有删除/);
 assert.match(await run({type:'group'}),/没有删除/);
 assert.match(await run(),/QQ私聊.*消息ID.*备份/);
 assert.equal((await store.privateHistory(scope)).length,0);
});
