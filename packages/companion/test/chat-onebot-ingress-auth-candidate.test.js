import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import {execFileSync} from 'node:child_process';
import {createHash, X509Certificate} from 'node:crypto';
import {WebSocketServer} from 'ws';
import {OneBot} from '../src/transport-onebot.js';
import * as transport from '../src/transport-onebot.js';
import * as bridgeModule from '../src/chat-onebot-queue-bridge.js';
import {EncryptedChatJournal} from '../src/chat-durable-journal-candidate.js';
import {DurableBatchCandidate,createTransportBoundMessageCandidate} from '../src/chat-durable-batch-candidate.js';
import {createAuthenticatedOneBotSender} from '../src/chat-onebot-authenticated-sender.js';
import {inspectTrustedRecovery} from '../src/chat-trusted-recovery.js';
import net from 'node:net';
import {initializeManagedStore,createManagedMemoryBrain} from '../src/memory-brain-trust.js';

const event={post_type:'message',message_type:'private',self_id:789,user_id:123,message_id:456,message:[{type:'text',data:{text:'fixture'}}]};
test('only pinned TLS websocket events receive owner-scoped ingress evidence', async()=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'ingress-tls-'));
 let bot,server,wss;
 try {
  const key=path.join(dir,'key'), cert=path.join(dir,'cert');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'],{stdio:'ignore'});
  const ca=fs.readFileSync(cert), pin=createHash('sha256').update(new X509Certificate(ca).raw).digest('hex');
  server=https.createServer({key:fs.readFileSync(key),cert:ca}); wss=new WebSocketServer({server});
  wss.on('connection',ws=>ws.send(JSON.stringify(event)));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const url=`wss://127.0.0.1:${server.address().port}`;
  assert.throws(()=>new OneBot({wsUrl:url,ingressAuthentication:{enabled:true,authenticated:true}}),/authentication/);
  assert.throws(()=>new OneBot({wsUrl:'ws://127.0.0.1',ingressAuthentication:{enabled:true,ca,certificateSha256:pin,ownerId:'123'}}),/authentication/);
  const bad=new OneBot({wsUrl:url,ingressAuthentication:{enabled:true,ca,certificateSha256:'00'.repeat(32),ownerId:'123'},onMessage:()=>assert.fail('wrong pin delivered event')});
  try {
   while(!bad.ws) await new Promise(r=>setTimeout(r,1));
   await new Promise(resolve=>bad.ws.once('close',resolve));
   assert.equal(bad.connected,false);
  } finally {bad.close();}
  let done;const received=new Promise(r=>done=r);
  bot=new OneBot({wsUrl:url,ingressAuthentication:{enabled:true,ca,certificateSha256:pin,ownerId:'123'},onMessage:done});
  bot.api=async()=>({ok:false});
  const msg=await Promise.race([received,new Promise((_,reject)=>setTimeout(()=>reject(Error('timeout')),3000))]);
  assert.equal(transport.snapshotAuthenticatedOneBotPrivateMessage(bot,msg,'123').text,'fixture');
  fs.mkdirSync(path.join(dir,'journal'),{mode:0o700});
  const journal=new EncryptedChatJournal({directory:path.join(dir,'journal'),key:Buffer.alloc(32,1)});
  try {
   const queue=new DurableBatchCandidate(journal), opts={queue,bot,sealKey:Buffer.alloc(32,2),ownerId:'123'};
   assert.throws(()=>bridgeModule.createAuthenticatedOneBotIngressCandidate(opts),/disabled/);
   const bridge=bridgeModule.createAuthenticatedOneBotIngressCandidate({...opts,enabled:true});
   assert.throws(()=>bridge.accept({...msg,authenticated:true}),/untrusted/);
   let receivedBody; server.on('request',(req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{receivedBody=JSON.parse(body);res.end(JSON.stringify({status:'ok',retcode:0}));});});
   const sender=createAuthenticatedOneBotSender({url:`https://127.0.0.1:${server.address().port}/`,ca,certificateSha256:pin,ownerId:'123'});
   const selectorKey=Buffer.alloc(32,3),socket=path.join(dir,'sender.sock');
   assert.throws(()=>bridgeModule.createAuthenticatedOneBotQueueCandidate({...opts,sender,selectorKey,generate:async()=>['reply']}),/disabled/);
   const directory=path.join(dir,'store'); initializeManagedStore(directory);
   const scope={tenant:'companion',platform:'qq',type:'private',session:'private:123',user:'123'};
   const store=createManagedMemoryBrain({backend:'sqlite-fts',directory,scope,sources:['qq-private-message'],trustedProcess:true});
   const candidate=bridgeModule.createAuthenticatedOneBotQueueCandidate({...opts,enabled:true,sender,selectorKey,store,scope,generate:async (messages,identity)=>{assert.equal(messages[0].text,'fixture');assert.equal(queue.list(session)[0].state,'generation-unknown');assert.equal(queue.list(session)[0].id,identity.batchId);return {segments:['reply'],history:await store.chatHistory(scope)};}});
   assert.throws(()=>candidate.accept({...msg}),/untrusted/);
   const {session}=candidate.accept(msg);
   const acceptedInput=queue.list(session)[0].input;
   assert.equal(bridge.reconstruct(session,acceptedInput).text,'fixture');
   await candidate.form(session,1);
   const unbound=bridgeModule.createAuthenticatedOneBotQueueCandidate({...opts,enabled:true,sender,selectorKey,generate:async()=>['unused']});
   const unboundService=await unbound.startSender({socket});
   try {
    const row=inspectTrustedRecovery(queue)[0],selector=bridgeModule.signBridgeSelector(selectorKey,{id:row.id,snapshot:row.snapshot,confirm:true});
    const result=await new Promise((resolve,reject)=>{let text='';const c=net.createConnection(socket,()=>c.write(JSON.stringify(selector)+'\n'));c.on('data',b=>text+=b);c.on('end',()=>resolve(JSON.parse(text)));c.on('error',reject);});
    assert.equal(result.status,'blocked'); assert.equal(receivedBody,undefined);
   } finally {await unboundService.close();}
   const service=await candidate.startSender({socket});
   try {
    const row=inspectTrustedRecovery(queue)[0],selector=bridgeModule.signBridgeSelector(selectorKey,{id:row.id,snapshot:row.snapshot,confirm:true});
    const result=await new Promise((resolve,reject)=>{let text='';const c=net.createConnection(socket,()=>c.write(JSON.stringify(selector)+'\n'));c.on('data',b=>text+=b);c.on('end',()=>resolve(JSON.parse(text)));c.on('error',reject);});
    assert.equal(result.status,'delivered');assert.deepEqual(receivedBody,{user_id:'123',message:'reply'});
   } finally {await service.close();}
   const legacy=createTransportBoundMessageCandidate({enabled:true,queue,bot,sealKey:opts.sealKey});
   const duplicate=legacy.accept(msg);
   assert.equal(duplicate.duplicate,true); assert.equal(duplicate.state,'delivered');
   assert.equal(queue.list(duplicate.session)[0].state,'history-pending');
   assert.throws(()=>legacy.reconstruct(session,acceptedInput),/mismatch/);
  } finally {journal.close();}
  assert.throws(()=>transport.snapshotAuthenticatedOneBotPrivateMessage(bot,msg,'124'),/untrusted/);
  assert.throws(()=>transport.snapshotAuthenticatedOneBotPrivateMessage(bot,{...msg,authenticated:true},'123'),/untrusted/);
  msg.text='changed'; assert.throws(()=>transport.snapshotAuthenticatedOneBotPrivateMessage(bot,msg,'123'),/untrusted/);
 } finally {bot?.close();wss?.close();if(server) await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});
