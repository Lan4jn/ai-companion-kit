import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {register} from 'node:module';
import {OneBot} from '../src/transport-onebot.js';
import {EncryptedChatJournal} from '../src/chat-durable-journal-candidate.js';
import {DurableBatchCandidate,createTransportBoundMessageCandidate,createPreGenerationBatchCandidate} from '../src/chat-durable-batch-candidate.js';
import {inspectTrustedRecovery,sendTrustedRecovery} from '../src/chat-trusted-recovery.js';
import {initializeManagedStore,createManagedMemoryBrain} from '../src/memory-brain-trust.js';
const scope={tenant:'companion',platform:'qq',type:'private',session:'private:123',user:'123'};
const managed=directory=>createManagedMemoryBrain({directory,scope,sources:['qq-private-message'],trustedProcess:true,backend:'sqlite-fts'});
register('./memory-brain-fake-ws-loader.js',import.meta.url);
test('explicit snapshot sends only one signed ready segment; unknown cannot be retried',async()=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'trusted-recovery-')); let bot,journal;
 try {
  let receive; const got=new Promise(r=>receive=r); bot=new OneBot({wsUrl:'ws://fixture',onMessage:receive});
  while(!bot.ws) await new Promise(r=>setTimeout(r,1));
  bot.ws.emit('open');
  bot.ws.emit('message',JSON.stringify({post_type:'message',self_id:789,message_type:'private',user_id:123,message_id:456,message:[{type:'text',data:{text:'fixture'}}]}));
  const msg=await got, sealKey=Buffer.alloc(32,9), key=Buffer.alloc(32,8);
  journal=new EncryptedChatJournal({directory:dir,key}); let queue=new DurableBatchCandidate(journal);
  const {session}=createTransportBoundMessageCandidate({enabled:true,queue,bot,sealKey}).accept(msg);
  const storeDir=path.join(dir,'store');initializeManagedStore(storeDir);const store=managed(storeDir);
  const prior={turnId:'prior',events:['onebot-message:100'],text:'old question',reply:'old answer'};
  assert.equal(await store.commitChatHistory(scope,prior),'inserted');
  let generated=0; await createPreGenerationBatchCandidate({enabled:true,queue,bot,sealKey,ownerId:'123',generate:async()=>{generated++;return {segments:['one','two'],history:await store.chatHistory(scope)}}}).form(session,1);
  journal.close(); journal=new EncryptedChatJournal({directory:dir,key}); queue=new DurableBatchCandidate(journal);
  let calls=[]; bot.send=async (...args)=>{calls.push(args);return {ok:true,data:{status:'ok',retcode:0}}};
  const first=inspectTrustedRecovery(queue)[0];
  assert.equal((await sendTrustedRecovery({queue,bot,sealKey,ownerId:'123',...first,snapshot:'0'.repeat(64)})).status,'blocked');
  assert.equal((await sendTrustedRecovery({queue,bot,sealKey,ownerId:'123',...first})).status,'blocked');
  assert.equal(calls.length,0);
  assert.equal((await sendTrustedRecovery({queue,bot,sealKey,ownerId:'123',store,scope:{...scope,user:'999'},...first})).status,'blocked');
  assert.equal(calls.length,0);
  assert.equal((await sendTrustedRecovery({queue,bot,sealKey,ownerId:'123',store,scope,...first})).status,'delivered');
  assert.equal((await sendTrustedRecovery({queue,bot,sealKey,ownerId:'123',...first})).status,'blocked');
  const second=inspectTrustedRecovery(queue)[0]; bot.send=async (...args)=>{calls.push(args);throw Error('ambiguous')};
  assert.equal((await sendTrustedRecovery({queue,bot,sealKey,ownerId:'123',store,scope,...second})).status,'unknown');
  const unknown=inspectTrustedRecovery(queue)[0]; assert.equal(unknown.state,'unknown');
  assert.equal((await sendTrustedRecovery({queue,bot,sealKey,ownerId:'123',store,scope,...unknown})).status,'blocked');
  assert.deepEqual(calls,[['private:123','one'],['private:123','two']]); assert.equal(generated,1);
 } finally {bot?.close();journal?.close();fs.rmSync(dir,{recursive:true,force:true});}
});


test('protected CLI requires exact snapshot and sends via isolated local socket',async()=>{
 const root=fs.mkdtempSync(path.join(process.env.TMPDIR,'trusted-cli-')); let bot,journal,server;
 const run=(...args)=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,['scripts/chat-trusted-recovery.mjs',...args]);let out='';p.stdout.on('data',b=>out+=b);p.on('error',reject);p.on('close',code=>resolve({code,out}));});
 try {
  const dir=path.join(root,'journal');fs.mkdirSync(dir,{mode:0o700});const key=Buffer.alloc(32,8),seal=Buffer.alloc(32,9),kp=path.join(root,'key'),sp=path.join(root,'seal'),sock=path.join(root,'send.sock');fs.writeFileSync(kp,key,{mode:0o600});fs.writeFileSync(sp,seal,{mode:0o600});
  let receive; const got=new Promise(r=>receive=r); bot=new OneBot({wsUrl:'ws://fixture',onMessage:receive});while(!bot.ws)await new Promise(r=>setTimeout(r,1));bot.ws.emit('open');bot.ws.emit('message',JSON.stringify({post_type:'message',self_id:789,message_type:'private',user_id:123,message_id:456,message:[{type:'text',data:{text:'fixture'}}]}));const msg=await got;
  const storeDir=path.join(root,'store');initializeManagedStore(storeDir);const store=managed(storeDir);
  await store.commitChatHistory(scope,{turnId:'prior',events:['onebot-message:100'],text:'old question',reply:'old answer'});
  journal=new EncryptedChatJournal({directory:dir,key});const queue=new DurableBatchCandidate(journal);const {session}=createTransportBoundMessageCandidate({enabled:true,queue,bot,sealKey:seal}).accept(msg);await createPreGenerationBatchCandidate({enabled:true,queue,bot,sealKey:seal,ownerId:'123',generate:async()=>({segments:['fixture output'],history:await store.chatHistory(scope)})}).form(session,1);journal.close();journal=null;
  let calls=[];server=net.createServer(conn=>{let text='';conn.on('data',b=>{text+=b;if(text.includes('\n')){calls.push(JSON.parse(text));conn.end(JSON.stringify({ok:true,data:{status:'ok',retcode:0}})+'\n');}})});await new Promise(r=>server.listen(sock,r));fs.chmodSync(sock,0o600);
  const base=['--directory',dir,'--key',kp];let result=await run('inspect',...base);assert.equal(result.code,0);const [row]=JSON.parse(result.out);
  const send=['send',...base,'--seal-key',sp,'--owner','123','--socket',sock,'--id',row.id,'--snapshot',row.snapshot,'--store-directory',storeDir];
  assert.equal((await run(...send)).code,1);assert.equal(calls.length,0);
  result=await run(...send,'--confirm-one-segment');assert.equal(result.code,0);assert.equal(JSON.parse(result.out).status,'delivered');assert.deepEqual(calls,[{destination:'private:123',segment:'fixture output'}]);assert.equal((await run(...send,'--confirm-one-segment')).code,1);
 } finally {bot?.close();journal?.close();if(server)await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});}
});
