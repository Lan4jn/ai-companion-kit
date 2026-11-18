import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash,createHmac,X509Certificate} from 'node:crypto';
import {EncryptedChatJournal} from '../src/chat-durable-journal-candidate.js';
import {initializeManagedStore,createManagedMemoryBrain} from '../src/memory-brain-trust.js';
import {createAuthenticatedOneBotSender} from '../src/chat-onebot-authenticated-sender.js';
import {startMainDurableChat} from '../src/chat-main-durable.js';
import {Memory} from '../src/memory.js';
import {Brain} from '../src/brain.js';
import {Role} from '../src/role.js';

test('history recovery does not automatically generate pre-existing accepted input',async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'durable-start-barrier-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const journalDir=path.join(dir,'journal');fs.mkdirSync(journalDir,{mode:0o700});
 const key=Buffer.alloc(32,43), keyPath=path.join(dir,'key');fs.writeFileSync(keyPath,key,{mode:0o600});
 const seal=createHmac('sha256',key).update('main-local-onebot-seal-v1').digest();
 const tag=(domain,data)=>createHmac('sha256',seal).update(domain+'\0').update(JSON.stringify(data)).digest('hex');
 const message=(id,text)=>({transport:'onebot-qq',conversation:'private:123',sender:'123',messageId:id,text});
 const bound=m=>({kind:'transport-bound-v1',message:m,tag:tag('companion-transport-bound-v1',m)});
 const session='transport-bound-v1:'+createHash('sha256').update(JSON.stringify(['onebot-qq','private:123'])).digest('hex');
 const row={kind:'batch-candidate-v1',version:1,type:'batch',id:'done',session,state:'history-pending',inputIds:['input1'],inputs:[bound(message('1','fixture first'))],destination:'private:123',segments:['fixture reply'],index:0,attempt:null};
 row.outputTags=row.segments.map((s,i)=>tag('companion-generated-batch-v1',[row.id,row.session,row.inputIds,row.inputs,row.destination,row.segments,i,s]));
 row.ackTag=tag('companion-history-ack-v1',[row.id,row.session,row.state,row.inputIds,row.inputs,row.destination,row.segments,row.outputTags]);
 let journal=new EncryptedChatJournal({directory:journalDir,key});
 journal.save([row,{kind:'batch-candidate-v1',version:1,type:'input',id:'input2',session,state:'accepted',input:bound(message('2','fixture pending'))}]);journal.close();
 const storeDir=path.join(dir,'store');initializeManagedStore(storeDir);
 const scope={tenant:'companion',platform:'qq',type:'private',session:'private:123',user:'123'};
 const memoryConfig={enabled:true,backend:'sqlite-fts',trustedProcess:true,trustedScope:scope,authorizedSources:['qq-private-message'],directory:storeDir};
 const store=createManagedMemoryBrain({...memoryConfig,scope,sources:memoryConfig.authorizedSources});
 const tlsKey=path.join(dir,'tls.key'),tlsCert=path.join(dir,'tls.crt');
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',tlsKey,'-out',tlsCert,'-days','1','-subj','/CN=localhost'],{stdio:'ignore'});
 const ca=fs.readFileSync(tlsCert),pin=new X509Certificate(ca).fingerprint256.replaceAll(':','').toLowerCase();
 const sender=createAuthenticatedOneBotSender({url:'https://127.0.0.1:1/',ca,certificateSha256:pin,ownerId:'123'});
 const card=path.join(dir,'role');fs.writeFileSync(card,'synthetic');
 const brain=new Brain({apiKey:'synthetic',baseUrl:'https://model.invalid',model:'fixture',role:new Role({cardPath:card}),ownerIds:['123'],memory:new Memory({dir:path.join(dir,'memory')})});
 const oldFetch=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('unexpected generation');};
 let runtime;
 try {
  runtime=startMainDurableChat({config:{enabled:true,trustLocalCard:true,ownerId:'123',directory:journalDir,keyPath},brain,bot:{},sender,ownerIds:['123'],memoryConfig});
  for(let i=0;i<150;i++){if((await store.chatHistory(scope)).length===1)break;await new Promise(r=>setTimeout(r,10));}
  assert.equal((await store.chatHistory(scope)).length,1);
  await new Promise(r=>setTimeout(r,500));
  await runtime.close();runtime=null;
  journal=new EncryptedChatJournal({directory:journalDir,key});
  assert.equal(journal.rows.length,1);assert.equal(journal.rows[0].id,'input2');assert.equal(journal.rows[0].state,'accepted');
  journal.close();assert.equal(calls,0);
 } finally {await runtime?.close();globalThis.fetch=oldFetch;}
});
