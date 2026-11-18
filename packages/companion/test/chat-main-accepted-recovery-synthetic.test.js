import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import {execFileSync} from 'node:child_process';
import {X509Certificate,createDecipheriv} from 'node:crypto';
import {WebSocketServer} from 'ws';
import {OneBot} from '../src/transport-onebot.js';
import {createAuthenticatedOneBotSender} from '../src/chat-onebot-authenticated-sender.js';
import {startMainDurableChat} from '../src/chat-main-durable.js';
import {EncryptedChatJournal} from '../src/chat-durable-journal-candidate.js';
import {inspectAcceptedInput,authorizeAcceptedInput,inspectBoundBatch,authorizeReadyBatch} from '../src/chat-durable-offline-recovery.js';
import {initializeManagedStore} from '../src/memory-brain-trust.js';
import {Memory} from '../src/memory.js';
import {Brain} from '../src/brain.js';
import {Role} from '../src/role.js';

const wait=async f=>{for(let i=0;i<500;i++){if(f())return;await new Promise(r=>setTimeout(r,10));}throw Error('fixture timeout');};
const pause=()=>new Promise(r=>setTimeout(r,250));
function diskRows(dir,key){const b=JSON.parse(fs.readFileSync(path.join(dir,'journal.enc')));const d=createDecipheriv('aes-256-gcm',key,Buffer.from(b.iv,'base64'));d.setAuthTag(Buffer.from(b.tag,'base64'));const v=JSON.parse(Buffer.concat([d.update(Buffer.from(b.data,'base64')),d.final()]));return v.rows||v;}

test('authenticated legacy input needs offline generation and separate delivery approvals', {timeout:30000}, async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'main-accepted-'));const jd=path.join(dir,'journal');fs.mkdirSync(jd,{mode:0o700});const key=Buffer.alloc(32,17),kp=path.join(dir,'key'),card=path.join(dir,'role');fs.writeFileSync(kp,key,{mode:0o600});fs.writeFileSync(card,'synthetic card');
 const tk=path.join(dir,'tls.key'),tc=path.join(dir,'tls.crt');execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',tk,'-out',tc,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});const ca=fs.readFileSync(tc),pin=new X509Certificate(ca).fingerprint256.replaceAll(':','').toLowerCase();
 let sends=0,generations=0,ws,bot,runtime,ref,ingressError,failGeneration=false,unknownSend=false;const originalFetch=globalThis.fetch;
 const server=https.createServer({key:fs.readFileSync(tk),cert:ca},(req,res)=>{req.resume();req.on('end',()=>{if(req.url==='/send_private_msg')sends++;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(unknownSend?{status:'async'}:{status:'ok',retcode:0,data:{message_id:9}}));});});const wss=new WebSocketServer({server});
 t.after(async()=>{await runtime?.close();bot?.close();globalThis.fetch=originalFetch;wss.clients.forEach(s=>s.terminate());await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));wss.on('connection',s=>ws=s);const url=`127.0.0.1:${server.address().port}`;
 const scope={tenant:'companion',platform:'qq',type:'private',session:'private:123',user:'123'},storeDir=path.join(dir,'store');initializeManagedStore(storeDir);
 const memoryConfig={enabled:true,backend:'sqlite-fts',trustedProcess:true,trustedScope:scope,authorizedSources:['qq-private-message'],directory:storeDir};
 const brain=new Brain({apiKey:'fixture',baseUrl:'https://model.invalid/v1',model:'fixture',role:new Role({cardPath:card}),ownerIds:['123'],memory:new Memory({dir:path.join(dir,'memory')})});
 const config={enabled:true,trustLocalCard:true,ownerId:'123',directory:jd,keyPath:kp};
 bot=new OneBot({wsUrl:`wss://${url}`,httpUrl:'',ingressAuthentication:{enabled:true,ca,certificateSha256:pin,ownerId:'123'},dataDir:dir,onMessage:m=>{try{ref=runtime.accept(m,30000);}catch(e){ingressError=e;}}});
 const sender=createAuthenticatedOneBotSender({url:`https://${url}/`,ca,certificateSha256:pin,ownerId:'123'});
 const start=()=>startMainDurableChat({config,brain,bot,sender,ownerIds:['123'],memoryConfig});
 globalThis.fetch=async(url,opts)=>{if(String(url).startsWith('https://model.invalid/')){generations++;assert.equal(diskRows(jd,key)[0].state,'generation-unknown');if(failGeneration) return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:'',tool_calls:[{}]}}]})};return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:'synthetic reply'}}]})};}return originalFetch(url,opts);};
 runtime=start();await wait(()=>ws);const send=(user,id,text)=>ws.send(JSON.stringify({post_type:'message',message_type:'private',self_id:789,user_id:user,message_id:id,message:[{type:'text',data:{text}}]}));
 send(123,1,'synthetic input');await wait(()=>ref);assert.equal(ref.duplicate,false);await runtime.close();runtime=null;
 let journal=new EncryptedChatJournal({directory:jd,key});let row=journal.rows[0];assert.equal(row.state,'accepted');const id=row.id;
 assert.throws(()=>inspectAcceptedInput(journal,id,'999'));const forged=structuredClone(row);forged.input.message.text='forged';journal.save([forged]);assert.throws(()=>inspectAcceptedInput(journal,id,'123'));journal.save([row]);journal.close();
 runtime=start();await pause();assert.equal(generations,0);assert.equal(sends,0);assert.throws(()=>new EncryptedChatJournal({directory:jd,key}),/lock/);await runtime.close();runtime=null;
 journal=new EncryptedChatJournal({directory:jd,key});const view=inspectAcceptedInput(journal,id,'123');assert.throws(()=>authorizeAcceptedInput(journal,{id,ownerId:'123',snapshot:view.snapshot,confirmNotGenerated:true}));authorizeAcceptedInput(journal,{id,ownerId:'123',snapshot:view.snapshot,confirmNotGenerated:true,confirmTrustedIngress:true});journal.close();
 runtime=start();await wait(()=>generations===1);await wait(()=>diskRows(jd,key)[0].state==='ready');await pause();assert.equal(sends,0);await runtime.close();runtime=null;
 journal=new EncryptedChatJournal({directory:jd,key});row=journal.rows[0];const output=inspectBoundBatch(journal,row.id,'123');assert.throws(()=>authorizeReadyBatch(journal,{id:row.id,ownerId:'123',snapshot:output.snapshot}));authorizeReadyBatch(journal,{id:row.id,ownerId:'123',snapshot:output.snapshot,confirmSend:true});journal.close();
 runtime=start();await wait(()=>sends===1);await wait(()=>diskRows(jd,key).length===0);ref=null;send(123,1,'synthetic input');await wait(()=>ref);assert.equal(ref.duplicate,true);send(999,2,'unauthorized');await wait(()=>ingressError);await pause();assert.equal(sends,1);assert.equal(generations,1);
 // A separately approved recovery whose send is uncertain is never resent on restart.
 ref=null;send(123,3,'unknown delivery');await wait(()=>ref);await runtime.close();runtime=null;
 journal=new EncryptedChatJournal({directory:jd,key});row=journal.rows[0];let v=inspectAcceptedInput(journal,row.id,'123');authorizeAcceptedInput(journal,{id:row.id,ownerId:'123',snapshot:v.snapshot,confirmNotGenerated:true,confirmTrustedIngress:true});journal.close();
 runtime=start();await wait(()=>generations===2);await wait(()=>diskRows(jd,key)[0].state==='ready');await runtime.close();runtime=null;
 journal=new EncryptedChatJournal({directory:jd,key});row=journal.rows[0];v=inspectBoundBatch(journal,row.id,'123');authorizeReadyBatch(journal,{id:row.id,ownerId:'123',snapshot:v.snapshot,confirmSend:true});journal.close();unknownSend=true;
 runtime=start();await wait(()=>sends===2);await wait(()=>diskRows(jd,key)[0].state==='unknown');await runtime.close();runtime=null;
 runtime=start();await pause();assert.equal(sends,2);assert.equal(generations,2);await runtime.close();runtime=null;
 journal=new EncryptedChatJournal({directory:jd,key});assert.throws(()=>inspectAcceptedInput(journal,journal.rows[0].id,'123'));journal.save([]);journal.close();
 // Synthetic cleanup above is not a recovery operation; exercise a fresh failed generation.
 runtime=start();ref=null;send(123,4,'failed generation');await wait(()=>ref);await runtime.close();runtime=null;
 journal=new EncryptedChatJournal({directory:jd,key});row=journal.rows[0];v=inspectAcceptedInput(journal,row.id,'123');authorizeAcceptedInput(journal,{id:row.id,ownerId:'123',snapshot:v.snapshot,confirmNotGenerated:true,confirmTrustedIngress:true});journal.close();
 failGeneration=true;runtime=start();await wait(()=>generations===3);await pause();assert.equal(diskRows(jd,key)[0].state,'generation-unknown');await runtime.close();runtime=null;
 runtime=start();await pause();assert.equal(generations,3);assert.equal(sends,2);
});
