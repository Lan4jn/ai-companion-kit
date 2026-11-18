import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import {execFileSync} from 'node:child_process';
import {X509Certificate} from 'node:crypto';
import {WebSocketServer} from 'ws';
import {OneBot} from '../src/transport-onebot.js';
import {Memory} from '../src/memory.js';
import {initializeManagedStore,createManagedMemoryBrain} from '../src/memory-brain-trust.js';
import {Brain} from '../src/brain.js';
import {Role} from '../src/role.js';
import {prepareChatParts} from '../src/humanize.js';
import {createAuthenticatedOneBotSender} from '../src/chat-onebot-authenticated-sender.js';
import {startMainDurableChat} from '../src/chat-main-durable.js';

const waitFor=async f=>{for(let i=0;i<300;i++){if(f())return;await new Promise(r=>setTimeout(r,10));} throw Error('fixture timeout');};
for (const failure of [false,'unknown','permanent','over']) test(`durable bounded reply; ${failure?failure+' stops delivery':'all acknowledged'}`,async()=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'durable-long-')); const journal=path.join(dir,'journal'); fs.mkdirSync(journal,{mode:0o700});
 const key=path.join(dir,'key'),card=path.join(dir,'role'),tlsKey=path.join(dir,'tls.key'),tlsCert=path.join(dir,'tls.crt');
 fs.writeFileSync(key,Buffer.alloc(32,4),{mode:0o600});fs.writeFileSync(card,'synthetic role');
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',tlsKey,'-out',tlsCert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
 const ca=fs.readFileSync(tlsCert),pin=new X509Certificate(ca).fingerprint256.replaceAll(':','').toLowerCase();
 const sends=[]; const server=https.createServer({key:fs.readFileSync(tlsKey),cert:ca},(req,res)=>{let b='';req.on('data',x=>b+=x);req.on('end',()=>{sends.push(JSON.parse(b).message);if(failure && sends.length===2){if(failure==='unknown') req.socket.destroy();else {res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({status:'failed',retcode:1}));}return;}res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({status:'ok',retcode:0,data:{message_id:sends.length}}));});});
 const wss=new WebSocketServer({server});let ws,bot,runtime;const old=globalThis.fetch;let generations=0;
 const answer=failure==='over'?'长'.repeat(51):'第一条。\n\n第二条。\n\n第三条。'; const expected=prepareChatParts(answer).parts.map(part=>part.trim());
 const scope={tenant:'companion',platform:'qq',type:'private',session:'private:123',user:'123'};
 const storeDir=path.join(dir,'store'); initializeManagedStore(storeDir);
 const memoryConfig={enabled:true,backend:'sqlite-fts',trustedProcess:true,trustedScope:scope,authorizedSources:['qq-private-message'],directory:storeDir};
 const store=createManagedMemoryBrain({...memoryConfig,scope,sources:memoryConfig.authorizedSources});
 try {
  if(failure==='over') assert.equal(Array.from(answer).length,51); else {assert.ok(Array.from(answer).length<=50);assert.equal(expected.length,3);} await new Promise(r=>server.listen(0,'127.0.0.1',r));wss.on('connection',s=>ws=s);
  globalThis.fetch=async()=>{generations++;return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:answer}}]})};};
  const memory=new Memory({dir:path.join(dir,'memory')});const brain=new Brain({apiKey:'fixture',baseUrl:'https://model.invalid',role:new Role({cardPath:card}),ownerIds:['123'],memory});
  const port=server.address().port;bot=new OneBot({wsUrl:`wss://127.0.0.1:${port}`,httpUrl:'',ingressAuthentication:{enabled:true,ca,certificateSha256:pin,ownerId:'123'},dataDir:dir,onMessage:m=>runtime.accept(m)});
  const sender=createAuthenticatedOneBotSender({url:`https://127.0.0.1:${port}/`,ca,certificateSha256:pin,ownerId:'123'});
  runtime=startMainDurableChat({config:{enabled:true,trustLocalCard:true,ownerId:'123',directory:journal,keyPath:key},brain,bot,sender,ownerIds:['123'],memoryConfig});
  await waitFor(()=>ws);const send=(id)=>ws.send(JSON.stringify({post_type:'message',message_type:'private',self_id:789,user_id:123,message_id:id,message:[{type:'text',data:{text:'question'}}]}));
  send(1);
  if(failure==='over') {await waitFor(()=>generations>=6);await new Promise(r=>setTimeout(r,250));assert.deepEqual(sends,[]);assert.deepEqual(await store.chatHistory(scope),[]);assert.equal(memory.sessionTurns('private:123',10).length,0);}
  else await waitFor(()=>sends.length>=(failure?2:expected.length));
  if(failure==='over') { /* failed compaction must remain silent */ }
  else if(failure){send(2);await new Promise(r=>setTimeout(r,250));assert.deepEqual(sends,expected.slice(0,2));assert.equal(generations,1);assert.equal(memory.sessionTurns('private:123',10).length,0);await runtime.close();runtime=startMainDurableChat({config:{enabled:true,trustLocalCard:true,ownerId:'123',directory:journal,keyPath:key},brain,bot,sender,ownerIds:['123'],memoryConfig});send(3);await new Promise(r=>setTimeout(r,250));assert.deepEqual(sends,expected.slice(0,2));assert.equal(generations,1);}
  else {for(let i=0;i<200 && !(await store.chatHistory(scope)).length;i++) await new Promise(r=>setTimeout(r,10));const history=await store.chatHistory(scope);assert.deepEqual(sends,expected);assert.equal(sends.length,3);assert.deepEqual(sends,['第一条。','第二条。','第三条。']);assert.equal(history[0].reply,sends.join(''));}
 } finally {runtime?.stop();await runtime?.close();bot?.close();globalThis.fetch=old;wss.clients.forEach(s=>s.terminate());await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});
