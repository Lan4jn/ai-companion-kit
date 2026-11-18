import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import {execFileSync} from 'node:child_process';
import {X509Certificate} from 'node:crypto';
import {createAuthenticatedOneBotSender} from '../src/chat-onebot-authenticated-sender.js';
import {WebSocketServer} from 'ws';
import {OneBot} from '../src/transport-onebot.js';
import {Memory} from '../src/memory.js';
import {initializeManagedStore,createManagedMemoryBrain} from '../src/memory-brain-trust.js';
import {Brain} from '../src/brain.js';
import {Role} from '../src/role.js';
import {startMainDurableChat} from '../src/chat-main-durable.js';

const waitFor=async f=>{for(let i=0;i<200;i++){if(f())return;await new Promise(r=>setTimeout(r,10));} throw Error('fixture timeout');};
test('full scoped history prevents sending another turn',async()=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'main-durable-')); const journalDir=path.join(dir,'journal');fs.mkdirSync(journalDir,{mode:0o700});
 const keyPath=path.join(dir,'key'), card=path.join(dir,'role');fs.writeFileSync(keyPath,Buffer.alloc(32,4),{mode:0o600});fs.writeFileSync(card,'only synthetic trusted card');
 const tlsKey=path.join(dir,'tls.key'),tlsCert=path.join(dir,'tls.crt');
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',tlsKey,'-out',tlsCert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
 const ca=fs.readFileSync(tlsCert),pin=new X509Certificate(ca).fingerprint256.replaceAll(':','').toLowerCase();
 const httpServer=https.createServer({key:fs.readFileSync(tlsKey),cert:ca},(req,res)=>{let b='';req.on('data',x=>b+=x);req.on('end',()=>{if(req.url==='/send_private_msg') sends.push(JSON.parse(b));res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({status:'ok',retcode:0,data:{message_id:1}}));});});
 const wss=new WebSocketServer({server:httpServer});const sends=[], payloads=[];let ws,bot,runtime;const old=globalThis.fetch;
 try {
  await new Promise(r=>httpServer.listen(0,'127.0.0.1',r));wss.on('connection',s=>ws=s);
  globalThis.fetch=async(url,opts)=>{if(String(url).startsWith('https://model.invalid/')) {payloads.push(JSON.parse(opts.body));return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:'hello back'}}]})};}return old(url,opts);};
  const storeDir=path.join(dir,'store'); initializeManagedStore(storeDir);
  const scope={tenant:'companion',platform:'qq',type:'private',session:'private:123',user:'123'};
  const memoryConfig={enabled:true,trustedProcess:true,trustedScope:scope,authorizedSources:['qq-private-message'],directory:storeDir,backend:'sqlite-fts',maxChatHistoryTurns:1};
  const store=createManagedMemoryBrain({...memoryConfig,scope,sources:memoryConfig.authorizedSources});
  const memory=new Memory({dir:path.join(dir,'memory')});
  memory.logTurn({where:'private:123',text:'old question',reply:'old answer'}); memory.logTurn({where:'private:999',text:'secret',reply:'secret reply'});
  const brain=new Brain({apiKey:'fixture',baseUrl:'https://model.invalid',model:'fixture',role:new Role({cardPath:card}),ownerIds:['123'],memory});
  const port=httpServer.address().port;
  bot=new OneBot({wsUrl:`wss://127.0.0.1:${port}`,httpUrl:'',ingressAuthentication:{enabled:true,ca,certificateSha256:pin,ownerId:'123'},dataDir:dir,onMessage:m=>runtime.accept(m)});
  const sender=createAuthenticatedOneBotSender({url:`https://127.0.0.1:${port}/`,ca,certificateSha256:pin,ownerId:'123'});
  assert.throws(()=>startMainDurableChat({config:{enabled:true,trustLocalCard:true,ownerId:'123',directory:journalDir,keyPath},brain,bot,ownerIds:['123']}),/authenticated.*sender/i);
  runtime=startMainDurableChat({config:{enabled:true,trustLocalCard:true,ownerId:'123',directory:journalDir,keyPath},brain,bot,sender,ownerIds:['123'],memoryConfig});
  await waitFor(()=>ws);const send=(id,text)=>ws.send(JSON.stringify({post_type:'message',message_type:'private',self_id:789,user_id:123,message_id:id,message:[{type:'text',data:{text}}]}));
  send(1,'first');await waitFor(()=>sends.length===1);assert.equal(payloads.length,1);assert.match(payloads[0].messages[0].content,/only synthetic trusted card/);assert.deepEqual(payloads[0].messages.slice(1),[{role:'user',content:'first'}]);
  await waitFor(()=>runtime && sends.length===1); for(let i=0;i<200 && !(await store.chatHistory(scope)).length;i++) await new Promise(r=>setTimeout(r,10)); assert.equal((await store.chatHistory(scope))[0].events[0],'onebot-message:1');
  send(2,'second'); await new Promise(r=>setTimeout(r,1200)); assert.equal(sends.length,1); assert.equal((await store.chatHistory(scope)).length,1);

 } finally {runtime?.stop();await runtime?.close();bot?.close();globalThis.fetch=old;wss.clients.forEach(s=>s.terminate());await new Promise(r=>wss.close(r));await new Promise(r=>httpServer.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});
