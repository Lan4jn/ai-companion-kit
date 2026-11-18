import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import {execFileSync} from 'node:child_process';
import {createHash,X509Certificate} from 'node:crypto';
import {WebSocketServer} from 'ws';
import {Brain} from '../src/brain.js';
import {Role} from '../src/role.js';
import {OneBot} from '../src/transport-onebot.js';
import {EncryptedChatJournal} from '../src/chat-durable-journal-candidate.js';
import {DurableBatchCandidate} from '../src/chat-durable-batch-candidate.js';
import {createAuthenticatedOneBotQueueCandidate} from '../src/chat-onebot-queue-bridge.js';
import {createAuthenticatedOneBotSender} from '../src/chat-onebot-authenticated-sender.js';
import {initializeManagedStore,createManagedMemoryBrain} from '../src/memory-brain-trust.js';

test('real Brain queue generation is opt-in, authenticated, tool-free, and never replays unknown', async()=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'brain-durable-')); let bot,journal,server,wss; const old=globalThis.fetch;
 try {
  const tlsKey=path.join(dir,'key'), cert=path.join(dir,'cert');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',tlsKey,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
  const ca=fs.readFileSync(cert), pin=createHash('sha256').update(new X509Certificate(ca).raw).digest('hex');
  server=https.createServer({key:fs.readFileSync(tlsKey),cert:ca}); wss=new WebSocketServer({server});
  wss.on('connection',ws=>ws.send(JSON.stringify({post_type:'message',message_type:'private',self_id:789,user_id:123,message_id:456,message:[{type:'text',data:{text:'hello'}}]})));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  let receive; const got=new Promise(r=>receive=r);
  bot=new OneBot({wsUrl:`wss://127.0.0.1:${server.address().port}`,ingressAuthentication:{enabled:true,ca,certificateSha256:pin,ownerId:'123'},onMessage:receive});
  const msg=await got, key=Buffer.alloc(32,8), sealKey=Buffer.alloc(32,9), selectorKey=Buffer.alloc(32,10);
  journal=new EncryptedChatJournal({directory:dir,key}); let queue=new DurableBatchCandidate(journal);
  const sender=createAuthenticatedOneBotSender({url:'https://localhost/',ca:Buffer.from('fixture'),certificateSha256:'a'.repeat(64),ownerId:'123'});
  const rolePath=path.join(dir,'role.md'); fs.writeFileSync(rolePath,'synthetic persona for testing');
  const bomb=new Proxy({}, {get(){throw Error('side effect access')}});
  const brain=new Brain({apiKey:'fixture',baseUrl:'https://fixture.invalid',model:'fixture',ownerIds:['123'],memory:bomb,role:new Role({cardPath:rolePath}),recall:()=>{throw Error('recall')}});
  const scope={tenant:'companion',platform:'qq',type:'private',session:'private:123',user:'123'},directory=path.join(dir,'store');
  initializeManagedStore(directory);
  const store=createManagedMemoryBrain({directory,scope,sources:['qq-private-message'],trustedProcess:true,backend:'sqlite-fts'});
  const opts={enabled:true,queue,bot,sender,sealKey,selectorKey,ownerId:'123',brain,store,scope};
  assert.throws(()=>createAuthenticatedOneBotQueueCandidate(opts),/disabled/);
  await assert.rejects(brain.generateDurableTextCandidate([{sender:'123',conversation:'private:123',text:'forged'}],{}),/authorization/);
  let calls=0;
  globalThis.fetch=async(url,req)=>{calls++; const payload=JSON.parse(req.body); assert.equal(queue.list(session)[0].state,'generation-unknown'); assert.equal(url,'https://fixture.invalid/chat/completions'); assert.equal(payload.tool_choice,'none'); assert.ok(!payload.tools); assert.ok(payload.messages.every(m=>typeof m.content==='string')); return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:'hello back'}}]})};};
  const bridge=createAuthenticatedOneBotQueueCandidate({...opts,brainGenerationEnabled:true,trustLocalCard:true});
  const {session}=bridge.accept(msg); const row=await bridge.form(session,1);
  assert.deepEqual(row.segments,['hello back']); assert.equal(calls,1);
  assert.throws(()=>bridge.accept({...msg}),/authenticated|trusted|message/i);
  // A malformed provider response leaves a durable unknown, including across restart.
  let receiveAgain; const again=new Promise(r=>receiveAgain=r); bot.onMessage=receiveAgain;
  for (const ws of wss.clients) ws.send(JSON.stringify({post_type:'message',message_type:'private',self_id:789,user_id:123,message_id:457,message:[{type:'text',data:{text:'again'}}]}));
  const next=await again;
  // Use a separate session/journal so the ready first batch is not delivered.
  journal.close(); fs.mkdirSync(path.join(dir,'second'),{mode:0o700});
  journal=new EncryptedChatJournal({directory:path.join(dir,'second'),key}); queue=new DurableBatchCandidate(journal);
  const retryOpts={...opts,queue,brainGenerationEnabled:true,trustLocalCard:true};
  const retryBridge=createAuthenticatedOneBotQueueCandidate(retryOpts);
  const second=retryBridge.accept(next);
  globalThis.fetch=async()=>{calls++;return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:'fake',tool_calls:[{id:'1'}]}}]})};};
  await assert.rejects(retryBridge.form(second.session,1),/invalid generation response/);
  assert.equal(queue.list(second.session)[0].state,'generation-unknown');
  journal.close(); journal=new EncryptedChatJournal({directory:path.join(dir,'second'),key}); queue=new DurableBatchCandidate(journal);
  const reopened=createAuthenticatedOneBotQueueCandidate({...retryOpts,queue});
  await assert.rejects(reopened.form(second.session,1),/blocked/);
  assert.equal(calls,2); assert.equal(reopened.accept(next).duplicate,true);
 } finally {globalThis.fetch=old;bot?.close();journal?.close();wss?.close();if(server)await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});
