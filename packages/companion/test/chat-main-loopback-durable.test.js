import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {execFileSync} from 'node:child_process';
import {X509Certificate} from 'node:crypto';
import {createMainDurableTransport} from '../src/chat-main-durable.js';
import {WebSocketServer} from 'ws';
import {OneBot} from '../src/transport-onebot.js';
import {Memory} from '../src/memory.js';
import {initializeManagedStore,createManagedMemoryBrain} from '../src/memory-brain-trust.js';
import {Brain} from '../src/brain.js';
import {Role} from '../src/role.js';
import {startMainDurableChat} from '../src/chat-main-durable.js';

const waitFor=async f=>{for(let i=0;i<200;i++){if(f())return;await new Promise(r=>setTimeout(r,10));} throw Error('fixture timeout');};
test('legacy backend refuses durable startup without side effects',async()=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'main-durable-')); const journalDir=path.join(dir,'journal');fs.mkdirSync(journalDir,{mode:0o700});
 const keyPath=path.join(dir,'key'), card=path.join(dir,'role');fs.writeFileSync(keyPath,Buffer.alloc(32,4),{mode:0o600});fs.writeFileSync(card,'only synthetic trusted card');
 const httpServer=http.createServer((req,res)=>{let b='';req.on('data',x=>b+=x);req.on('end',()=>{if(req.url==='/send_private_msg') sends.push(JSON.parse(b));res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({status:'ok',retcode:0,data:{message_id:1}}));});});
 const wss=new WebSocketServer({server:httpServer});const sends=[], payloads=[];let ws,bot,runtime;const old=globalThis.fetch;
 try {
  await new Promise(r=>httpServer.listen(0,'127.0.0.1',r));wss.on('connection',s=>ws=s);
  globalThis.fetch=async(url,opts)=>{if(String(url).startsWith('https://model.invalid/')) {payloads.push(JSON.parse(opts.body));return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:payloads.length===1?'hello back':'bad',...(payloads.length===1?{}:{tool_calls:[{}]})}}]})};}return old(url,opts);};
  const storeDir=path.join(dir,'store'); initializeManagedStore(storeDir);
  const scope={tenant:'companion',platform:'qq',type:'private',session:'private:123',user:'123'};
  const memoryConfig={enabled:true,trustedProcess:true,trustedScope:scope,authorizedSources:['qq-private-message'],directory:storeDir};
  const store=createManagedMemoryBrain({...memoryConfig,backend:'sqlite-fts',scope,sources:memoryConfig.authorizedSources});
  await store.commitChatHistory(scope,{turnId:'old',events:['onebot-message:100'],text:'old question',reply:'old answer'});
  const memory=new Memory({dir:path.join(dir,'memory')});
  memory.logTurn({where:'private:123',text:'old question',reply:'old answer'}); memory.logTurn({where:'private:999',text:'secret',reply:'secret reply'});
  const brain=new Brain({apiKey:'fixture',baseUrl:'https://model.invalid',model:'fixture',role:new Role({cardPath:card}),ownerIds:['123'],memory});
  const port=httpServer.address().port;
  const onebot={wsUrl:`ws://127.0.0.1:${port}`,httpUrl:''};
  const transport=createMainDurableTransport({config:{enabled:true,ownerId:'123',transport:{trustLoopbackOneBot:true,senderUrl:`http://127.0.0.1:${port}/`}},onebot,ownerIds:['123']});
  bot=new OneBot({...onebot,ingressAuthentication:transport.ingressAuthentication,dataDir:dir,onMessage:m=>runtime.accept(m)});
  const sender=transport.sender;
  assert.throws(()=>startMainDurableChat({config:{enabled:true,trustLocalCard:true,ownerId:'123',directory:journalDir,keyPath},brain,bot,ownerIds:['123']}),/authenticated.*sender/i);
  const before=await store.chatHistory(scope); const journalBefore=fs.readdirSync(journalDir);
  assert.throws(()=>startMainDurableChat({config:{enabled:true,trustLocalCard:true,ownerId:'123',directory:journalDir,keyPath},brain,bot,sender,ownerIds:['123'],memoryConfig}),/atomic history reservation requires sqlite-fts/);
  assert.deepEqual(await store.chatHistory(scope),before); assert.deepEqual(fs.readdirSync(journalDir),journalBefore);
  assert.deepEqual(sends,[]); assert.deepEqual(payloads,[]);
 } finally {runtime?.stop();await runtime?.close();bot?.close();globalThis.fetch=old;wss.clients.forEach(s=>s.terminate());await new Promise(r=>wss.close(r));await new Promise(r=>httpServer.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});
