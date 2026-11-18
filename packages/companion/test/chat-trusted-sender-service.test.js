import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import https from 'node:https';
import http from 'node:http';
import {createHash, X509Certificate} from 'node:crypto';
import {execFileSync,spawn} from 'node:child_process';
import {register} from 'node:module';
import {startTrustedSenderService} from '../src/chat-trusted-sender-service.js';
import {EncryptedChatJournal} from '../src/chat-durable-journal-candidate.js';
import {DurableBatchCandidate,createTransportBoundMessageCandidate,createPreGenerationBatchCandidate} from '../src/chat-durable-batch-candidate.js';
import {inspectTrustedRecovery} from '../src/chat-trusted-recovery.js';
import {OneBot} from '../src/transport-onebot.js';
import {initializeManagedStore,createManagedMemoryBrain} from '../src/memory-brain-trust.js';
const scope={tenant:'companion',platform:'qq',type:'private',session:'private:123',user:'123'};
function managed(root){const directory=path.join(root,'store');initializeManagedStore(directory);return createManagedMemoryBrain({backend:'sqlite-fts',directory,scope,sources:['qq-private-message'],trustedProcess:true});}
register('./memory-brain-fake-ws-loader.js',import.meta.url);
const ask=(socket,request)=>new Promise((resolve,reject)=>{let text='';const c=net.createConnection(socket,()=>c.write(JSON.stringify(request)+'\n'));c.on('data',b=>text+=b);c.on('end',()=>{try{resolve(JSON.parse(text));}catch(e){reject(e);}});c.on('error',reject)});

test('sender service is opt-in and refuses missing endpoint identity evidence', async()=>{
 await assert.rejects(startTrustedSenderService(), /disabled/);
 await assert.rejects(startTrustedSenderService({enabled:true, endpoint:{port:1234}}), /identity/);
});

test('private Unix endpoint integrates with durable sender and never retries unknown', async()=>{
 const root=fs.mkdtempSync(path.join(process.env.TMPDIR,'sender-unix-'));let server,service,journal,bot;
 try {
  const dir=path.join(root,'journal');fs.mkdirSync(dir,{mode:0o700});
  const key=Buffer.alloc(32,1),seal=Buffer.alloc(32,2),keyPath=path.join(root,'key'),sealKeyPath=path.join(root,'seal'),socket=path.join(root,'sender.sock'),endpointPath=path.join(root,'onebot.sock');
  fs.writeFileSync(keyPath,key,{mode:0o600});fs.writeFileSync(sealKeyPath,seal,{mode:0o600});
  let receive;const message=new Promise(r=>receive=r);bot=new OneBot({wsUrl:'ws://fixture',onMessage:receive});while(!bot.ws)await new Promise(r=>setTimeout(r,1));
  bot.ws.emit('open'); bot.ws.emit('message',JSON.stringify({post_type:'message',self_id:789,message_type:'private',user_id:123,message_id:456,message:[{type:'text',data:{text:'fixture'}}]}));
  journal=new EncryptedChatJournal({directory:dir,key});const queue=new DurableBatchCandidate(journal);
  const {session}=createTransportBoundMessageCandidate({enabled:true,queue,bot,sealKey:seal}).accept(await message);
  const store=managed(root);
  await createPreGenerationBatchCandidate({enabled:true,queue,bot,sealKey:seal,ownerId:'123',generate:async()=>({segments:['synthetic output'],history:await store.chatHistory(scope)})}).form(session,1);
  const row=inspectTrustedRecovery(queue)[0];journal.close();journal=null;let calls=0;
  server=http.createServer((req,res)=>{calls++;assert.equal(req.headers.authorization,undefined);req.resume();req.on('end',()=>res.destroy());});
  await new Promise(r=>server.listen(endpointPath,r));fs.chmodSync(endpointPath,0o600);
  service=await startTrustedSenderService({enabled:true,directory:dir,keyPath,sealKeyPath,ownerId:'123',socket,store,scope,endpoint:{unixSocketPath:endpointPath}});
  const request={id:row.id,snapshot:row.snapshot,confirm:true};
  assert.equal((await ask(socket,request)).status,'unknown');assert.equal((await ask(socket,request)).status,'blocked');assert.equal(calls,1);
  await service.close();service=null;journal=new EncryptedChatJournal({directory:dir,key});assert.equal(inspectTrustedRecovery(new DurableBatchCandidate(journal))[0].state,'unknown');
 } finally {if(service)await service.close();journal?.close();bot?.close();if(server)await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});}
});

for(const valid of [true,false]) test(`local TLS endpoint ${valid?'pinned':'wrong pin'}: signed segment ${valid?'ACK':'unknown and no retry'}`,async()=>{
 const root=fs.mkdtempSync(path.join(process.env.TMPDIR,'sender-service-'));let server,service,journal,bot;
 try {
  const dir=path.join(root,'journal');fs.mkdirSync(dir,{mode:0o700});
  const key=Buffer.alloc(32,1),seal=Buffer.alloc(32,2),keyPath=path.join(root,'key'),sealKeyPath=path.join(root,'seal'),tokenPath=path.join(root,'token'),socket=path.join(root,'sender.sock');
  fs.writeFileSync(keyPath,key,{mode:0o600});fs.writeFileSync(sealKeyPath,seal,{mode:0o600});fs.writeFileSync(tokenPath,'synthetic-test-token-123',{mode:0o600});
  let receive;const message=new Promise(r=>receive=r);bot=new OneBot({wsUrl:'ws://fixture',onMessage:receive});while(!bot.ws)await new Promise(r=>setTimeout(r,1));
  bot.ws.emit('open'); bot.ws.emit('message',JSON.stringify({post_type:'message',self_id:789,message_type:'private',user_id:123,message_id:456,message:[{type:'text',data:{text:'fixture'}}]}));
  journal=new EncryptedChatJournal({directory:dir,key});const queue=new DurableBatchCandidate(journal);
  const {session}=createTransportBoundMessageCandidate({enabled:true,queue,bot,sealKey:seal}).accept(await message);
  const store=managed(root);
  await createPreGenerationBatchCandidate({enabled:true,queue,bot,sealKey:seal,ownerId:'123',generate:async()=>({segments:['synthetic output'],history:await store.chatHistory(scope)})}).form(session,1);
  const row=inspectTrustedRecovery(queue)[0];journal.close();journal=null;
  const cert=path.join(root,'cert.pem'),certKey=path.join(root,'cert.key');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',certKey,'-out',cert,'-subj','/CN=fixture','-days','1'],{stdio:'ignore'});
  const pem=fs.readFileSync(cert),pin=createHash('sha256').update(new X509Certificate(pem).raw).digest('hex');let calls=0;
  server=https.createServer({key:fs.readFileSync(certKey),cert:pem},(req,res)=>{calls++;assert.equal(req.headers.authorization,'Bearer synthetic-test-token-123');assert.equal(req.url,'/send_private_msg');req.resume();res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({status:'ok',retcode:0}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  service=await startTrustedSenderService({enabled:true,directory:dir,keyPath,sealKeyPath,ownerId:'123',socket,store,scope,endpoint:{host:'127.0.0.1',port:server.address().port,certificateSha256:valid?pin:'0'.repeat(64),tokenPath}});
  const request={id:row.id,snapshot:row.snapshot,confirm:true};
  assert.equal((await ask(socket,request)).status,valid?'delivered':'unknown');
  assert.equal((await ask(socket,request)).status,'blocked');assert.equal(calls,valid?1:0);
  await service.close();service=null;
  journal=new EncryptedChatJournal({directory:dir,key});const rows=inspectTrustedRecovery(new DurableBatchCandidate(journal));
  assert.equal(rows.length,1);assert.equal(rows[0].state,valid?'history-pending':'unknown');
 } finally {if(service)await service.close();journal?.close();bot?.close();if(server)await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});}
});

for (const scenario of ['wrong scope','changed dependency','generation forget race','forgotten input','full capacity']) test(`service blocks ${scenario} before outbound send`,async()=>{
 const root=fs.mkdtempSync(path.join(process.env.TMPDIR,'sender-boundary-'));let server,service,journal,bot;
 try {
  const dir=path.join(root,'journal');fs.mkdirSync(dir,{mode:0o700});const key=Buffer.alloc(32,11),seal=Buffer.alloc(32,12),keyPath=path.join(root,'key'),sealKeyPath=path.join(root,'seal'),socket=path.join(root,'service.sock'),endpointPath=path.join(root,'endpoint.sock');
  fs.writeFileSync(keyPath,key,{mode:0o600});fs.writeFileSync(sealKeyPath,seal,{mode:0o600});
  const storeDir=path.join(root,'store');initializeManagedStore(storeDir);const store=createManagedMemoryBrain({backend:'sqlite-fts',directory:storeDir,scope,sources:['qq-private-message'],trustedProcess:true,maxChatHistoryTurns:scenario==='full capacity'?1:100});
  await store.commitChatHistory(scope,{turnId:'prior',events:['onebot-message:100'],text:'prior question',reply:'prior answer'});
  let receive;const message=new Promise(r=>receive=r);bot=new OneBot({wsUrl:'ws://fixture',onMessage:receive});while(!bot.ws)await new Promise(r=>setTimeout(r,1));bot.ws.emit('open');bot.ws.emit('message',JSON.stringify({post_type:'message',self_id:789,message_type:'private',user_id:123,message_id:456,message:[{type:'text',data:{text:'fixture'}}]}));
  journal=new EncryptedChatJournal({directory:dir,key});const queue=new DurableBatchCandidate(journal),{session}=createTransportBoundMessageCandidate({enabled:true,queue,bot,sealKey:seal}).accept(await message);
  await createPreGenerationBatchCandidate({enabled:true,queue,bot,sealKey:seal,ownerId:'123',generate:async()=>{const history=await store.chatHistory(scope);if(scenario==='generation forget race')await store.forget(scope,{source:'qq-private-message',evidence:'onebot-message:100'});return {segments:['synthetic output'],history};}}).form(session,1);
  const row=inspectTrustedRecovery(queue)[0];journal.close();journal=null;
  if(scenario==='changed dependency')await store.forget(scope,{source:'qq-private-message',evidence:'onebot-message:100'});
  if(scenario==='forgotten input')await store.forget(scope,{source:'qq-private-message',evidence:'onebot-message:456'});
  let calls=0;server=http.createServer((req,res)=>{calls++;req.resume();res.end(JSON.stringify({status:'ok',retcode:0}));});await new Promise(r=>server.listen(endpointPath,r));fs.chmodSync(endpointPath,0o600);
  service=await startTrustedSenderService({enabled:true,directory:dir,keyPath,sealKeyPath,ownerId:'123',socket,store,scope:scenario==='wrong scope'?{...scope,user:'999'}:scope,endpoint:{unixSocketPath:endpointPath}});
  assert.equal((await ask(socket,{id:row.id,snapshot:row.snapshot,confirm:true})).status,'blocked');assert.equal(calls,0);
  await service.close();service=null;journal=new EncryptedChatJournal({directory:dir,key});assert.equal(inspectTrustedRecovery(new DurableBatchCandidate(journal))[0].state,'ready');
 } finally {if(service)await service.close();journal?.close();bot?.close();if(server)await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});}
});

test('service holds related forget lock until an in-flight send resolves',async()=>{
 const root=fs.mkdtempSync(path.join(process.env.TMPDIR,'sender-race-'));let server,service,journal,bot,release;
 try {
  const dir=path.join(root,'journal');fs.mkdirSync(dir,{mode:0o700});const key=Buffer.alloc(32,21),seal=Buffer.alloc(32,22),keyPath=path.join(root,'key'),sealKeyPath=path.join(root,'seal'),socket=path.join(root,'service.sock'),endpointPath=path.join(root,'endpoint.sock');fs.writeFileSync(keyPath,key,{mode:0o600});fs.writeFileSync(sealKeyPath,seal,{mode:0o600});
  const store=managed(root);await store.commitChatHistory(scope,{turnId:'prior',events:['onebot-message:100'],text:'prior',reply:'answer'});
  let receive;const message=new Promise(r=>receive=r);bot=new OneBot({wsUrl:'ws://fixture',onMessage:receive});while(!bot.ws)await new Promise(r=>setTimeout(r,1));bot.ws.emit('open');bot.ws.emit('message',JSON.stringify({post_type:'message',self_id:789,message_type:'private',user_id:123,message_id:456,message:[{type:'text',data:{text:'fixture'}}]}));
  journal=new EncryptedChatJournal({directory:dir,key});const queue=new DurableBatchCandidate(journal),{session}=createTransportBoundMessageCandidate({enabled:true,queue,bot,sealKey:seal}).accept(await message);await createPreGenerationBatchCandidate({enabled:true,queue,bot,sealKey:seal,ownerId:'123',generate:async()=>({segments:['output'],history:await store.chatHistory(scope)})}).form(session,1);const row=inspectTrustedRecovery(queue)[0];journal.close();journal=null;
  let reached;const started=new Promise(r=>reached=r);const gate=new Promise(r=>release=r);server=http.createServer(async(req,res)=>{req.resume();reached();await gate;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({status:'ok',retcode:0}));});await new Promise(r=>server.listen(endpointPath,r));fs.chmodSync(endpointPath,0o600);
  service=await startTrustedSenderService({enabled:true,directory:dir,keyPath,sealKeyPath,ownerId:'123',socket,store,scope,endpoint:{unixSocketPath:endpointPath}});const sending=ask(socket,{id:row.id,snapshot:row.snapshot,confirm:true});await started;
  let forgotten=false;const forgetting=store.forget(scope,{source:'qq-private-message',evidence:'onebot-message:100'}).then(()=>{forgotten=true;});await new Promise(r=>setTimeout(r,300));assert.equal(forgotten,false);release();assert.equal((await sending).status,'delivered');await forgetting;assert.equal(forgotten,true);
 } finally {release?.();if(service)await service.close();journal?.close();bot?.close();if(server)await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});}
});

test('SIGKILL of service during outbound leaves unknown and never resends',async()=>{
 const root=fs.mkdtempSync(path.join(process.env.TMPDIR,'sender-kill-'));let server,service,journal,bot,child,held;
 try {
  const dir=path.join(root,'journal');fs.mkdirSync(dir,{mode:0o700});const key=Buffer.alloc(32,31),seal=Buffer.alloc(32,32),keyPath=path.join(root,'key'),sealKeyPath=path.join(root,'seal'),socket=path.join(root,'service.sock'),endpointPath=path.join(root,'endpoint.sock');fs.writeFileSync(keyPath,key,{mode:0o600});fs.writeFileSync(sealKeyPath,seal,{mode:0o600});const store=managed(root);
  let receive;const message=new Promise(r=>receive=r);bot=new OneBot({wsUrl:'ws://fixture',onMessage:receive});while(!bot.ws)await new Promise(r=>setTimeout(r,1));bot.ws.emit('open');bot.ws.emit('message',JSON.stringify({post_type:'message',self_id:789,message_type:'private',user_id:123,message_id:456,message:[{type:'text',data:{text:'fixture'}}]}));
  journal=new EncryptedChatJournal({directory:dir,key});const queue=new DurableBatchCandidate(journal),{session}=createTransportBoundMessageCandidate({enabled:true,queue,bot,sealKey:seal}).accept(await message);await createPreGenerationBatchCandidate({enabled:true,queue,bot,sealKey:seal,ownerId:'123',generate:async()=>({segments:['output'],history:await store.chatHistory(scope)})}).form(session,1);const row=inspectTrustedRecovery(queue)[0];journal.close();journal=null;
  let calls=0,reached;const started=new Promise(r=>reached=r);server=http.createServer((req,res)=>{calls++;held=res;req.resume();reached();});await new Promise(r=>server.listen(endpointPath,r));fs.chmodSync(endpointPath,0o600);
  const script=`import {startTrustedSenderService} from ${JSON.stringify(new URL('../src/chat-trusted-sender-service.js',import.meta.url).href)};import {createManagedMemoryBrain} from ${JSON.stringify(new URL('../src/memory-brain-trust.js',import.meta.url).href)};const p=JSON.parse(process.argv[1]);const store=createManagedMemoryBrain({backend:'sqlite-fts',directory:p.storeDir,scope:p.scope,sources:['qq-private-message'],trustedProcess:true});await startTrustedSenderService({...p,store,endpoint:{unixSocketPath:p.endpointPath}});process.stdout.write('READY\\n');`;
  child=spawn(process.execPath,['--input-type=module','-e',script,JSON.stringify({enabled:true,directory:dir,keyPath,sealKeyPath,ownerId:'123',socket,storeDir:path.join(root,'store'),scope,endpointPath})],{stdio:['ignore','pipe','pipe']});let errors='';child.stderr.on('data',b=>errors+=b);await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('exit',c=>reject(Error(`child exited ${c}: ${errors}`)));});
  const pending=ask(socket,{id:row.id,snapshot:row.snapshot,confirm:true}).catch(()=>null);await started;const exited=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));child.kill('SIGKILL');assert.equal((await exited).signal,'SIGKILL');await pending;held.destroy();child=null;
  // Fixture only: the killed worker is reaped and there are no other writers.
  assert.throws(()=>new EncryptedChatJournal({directory:dir,key}),/lock held or stale/);fs.rmdirSync(path.join(dir,'.journal.lock'));
  journal=new EncryptedChatJournal({directory:dir,key});const unknown=inspectTrustedRecovery(new DurableBatchCandidate(journal))[0];assert.equal(unknown.state,'unknown');journal.close();journal=null;fs.unlinkSync(socket);
  service=await startTrustedSenderService({enabled:true,directory:dir,keyPath,sealKeyPath,ownerId:'123',socket,store,scope,endpoint:{unixSocketPath:endpointPath}});assert.equal((await ask(socket,{id:unknown.id,snapshot:unknown.snapshot,confirm:true})).status,'blocked');assert.equal(calls,1);
 } finally {if(child){child.kill('SIGKILL');await new Promise(r=>child.once('exit',r));}held?.destroy();if(service)await service.close();journal?.close();bot?.close();if(server)await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});}
});
