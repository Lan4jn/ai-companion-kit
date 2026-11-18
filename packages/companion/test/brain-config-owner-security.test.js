import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {register} from 'node:module';
import {Brain} from '../src/brain.js';
import {OneBot} from '../src/transport-onebot.js';
import {handleTurn} from '../src/index.js';
register('./memory-brain-fake-ws-loader.js', import.meta.url);

async function event(user=11111,type='private') {
 let done; const p=new Promise(r=>done=r); const bot=new OneBot({wsUrl:'ws://fixture',onMessage:done});
 bot.api=async()=>({ok:false}); bot.getMyGroupCard=async()=>'';
 while(!bot.ws) await new Promise(r=>setTimeout(r,1));
 bot.ws.emit('open');
 bot.ws.emit('message',JSON.stringify({post_type:'message',message_type:type,user_id:user,group_id:55,message_id:234,message:[{type:'text',data:{text:'聊聊橘猫'}}]}));
 const msg=await p; bot.close(); return msg;
}

test('real QQ event authorizes configured owner only; cloned or cross-platform events cannot',async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'brain-owner-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let recalls=0; const requests=[];
 t.mock.method(globalThis,'fetch',async (_u,o)=>{requests.push(JSON.parse(o.body));return {ok:true,text:async()=>JSON.stringify({choices:[{message:{content:'好的'}}]})}});
 const memory={dir,remember:()=>{},logTurn:()=>{},recallTurns:()=>[],sessionTurns:()=>[],recallBiliFeelings:()=>{recalls++;return 'synthetic private feeling'}};
 const brain=new Brain({apiKey:'synthetic',ownerIds:['11111'],role:{build:({situation})=>situation},memory,dataDir:dir});
 const deps={brain,memory,bot:{},human:{},waker:{}}; const cfg={ownerIds:['11111'],dataDir:dir,dryRun:true};
 const owner=await event();
 for(const msg of [owner, await event(22222), await event(11111,'group'), {...owner}, {...owner,platform:'bili'}]) {
  await handleTurn(deps,[msg],cfg);
 }
 assert.equal(recalls,1);
 assert.match(JSON.stringify(requests[0]),/synthetic private feeling/);
 for(const r of requests.slice(1)) assert.doesNotMatch(JSON.stringify(r),/synthetic private feeling/);
});

test('caller cannot impersonate a configured QQ owner directly',async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'brain-spoof-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let count=0; t.mock.method(globalThis,'fetch',async()=>({ok:true,text:async()=>JSON.stringify({choices:[{message:{content:'好的'}}]})}));
 const brain=new Brain({apiKey:'synthetic',ownerIds:['11111'],role:{build:()=>''},memory:{recallTurns:()=>[],recallBiliFeelings:()=>{count++;return 'secret'}},dataDir:dir});
 await brain.reply({key:'private:11111',userId:'11111',platform:'qq',text:'你好',tools:false,record:false,isOwner:true});
 assert.equal(count,0);
});
