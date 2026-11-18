import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {register} from 'node:module';
import {Memory} from '../src/memory.js';
import {initializeManagedStore,createManagedMemoryBrain} from '../src/memory-brain-trust.js';
import {handleTurn} from '../src/index.js';
import {OneBot} from '../src/transport-onebot.js';
import {withForgetWrite} from '../src/chat-forget-coordination.js';
register('./memory-brain-fake-ws-loader.js', import.meta.url);

test('forget completed during generation suppresses stale ordinary reply', async t => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'chat-forget-inflight-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const memory=new Memory({dir}); memory.logTurn({where:'private:1',who:'1',text:'synthetic prior',reply:'prior reply'});
 const directory=path.join(dir,'memory-brain-scoped');
 const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'};
 initializeManagedStore(directory);
 const store=createManagedMemoryBrain({directory,scope,sources:['qq-private-message'],trustedProcess:true,backend:'sqlite-fts'});
 let resolveMessage, release, started; const startedPromise=new Promise(r=>started=r);
 const receiver=new OneBot({wsUrl:'ws://fixture',onMessage:m=>resolveMessage(m)}); receiver.api=async()=>({ok:false}); receiver.getMyGroupCard=async()=>'';
 while(!receiver.ws) await new Promise(r=>setTimeout(r,1)); receiver.ws.emit('open'); t.after(()=>receiver.close());
 const event=new Promise(r=>resolveMessage=r);
 receiver.ws.emit('message',JSON.stringify({post_type:'message',message_type:'private',user_id:1,message_id:12,message:[{type:'text',data:{text:'new synthetic'}}]}));
 let sends=0;
 const processing=handleTurn({memory,brain:{reply:async p=>{assert.equal(p.history[0].text,'synthetic prior'); started(); await new Promise(r=>release=r); return {text:'synthetic prior'};}},bot:{send:async()=>{sends++;return {ok:true};},setTyping:async()=>{}},human:{say:async (text,{send})=>{await send(text);return {ok:true,sent:1,parts:[text]};}},waker:{wake:()=>{}}},[await event],{ownerIds:['1'],dataDir:dir,memoryBrain:{enabled:false}});
 await startedPromise;
 await store.forget({tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'},{source:'qq-private-message',evidence:'onebot-message:11'});
 release(); await processing; assert.equal(sends,0);
});

test('real forget queued at delivery blocks stale text before transport starts', async t => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'chat-forget-delivery-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const directory=path.join(dir,'memory-brain-scoped');
 const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'};
 const memory=new Memory({dir});
 initializeManagedStore(directory);
 const store=createManagedMemoryBrain({directory,scope,sources:['qq-private-message'],trustedProcess:true,backend:'sqlite-fts'});
 let resolveMessage, sendReady, startSend, releaseGate, gateEntered;
 const ready=new Promise(r=>sendReady=r), start=new Promise(r=>startSend=r);
 const gateStarted=new Promise(r=>gateEntered=r), gateRelease=new Promise(r=>releaseGate=r);
 const receiver=new OneBot({wsUrl:'ws://fixture',onMessage:m=>resolveMessage(m)}); receiver.api=async()=>({ok:false}); receiver.getMyGroupCard=async()=>'';
 while(!receiver.ws) await new Promise(r=>setTimeout(r,1)); receiver.ws.emit('open'); t.after(()=>receiver.close());
 const event=new Promise(r=>resolveMessage=r);
 receiver.ws.emit('message',JSON.stringify({post_type:'message',message_type:'private',user_id:1,message_id:12,message:[{type:'text',data:{text:'new synthetic'}}]}));
 let sends=0;
 const processing=handleTurn({memory,brain:{reply:async()=>({text:'synthetic reply'})},bot:{send:async()=>{sends++;return {ok:true};},setTyping:async()=>{}},human:{say:async(text,{send})=>{sendReady();await start;return send(text);}},waker:{wake:()=>{}}},[await event],{ownerIds:['1'],dataDir:dir,memoryBrain:{enabled:false}});
 await ready;
 const gate=withForgetWrite(directory,scope,'qq-private-message',async()=>{gateEntered();await gateRelease;});
 await gateStarted;
 const forget=store.forget(scope,{source:'qq-private-message',evidence:'onebot-message:11'});
 // scoped() awaits authorization before entering the coordinator.
 await new Promise(r=>setImmediate(r));
 startSend(); await new Promise(r=>setImmediate(r));
 releaseGate(); await gate; await forget; await processing;
 assert.equal(sends,0);
});
