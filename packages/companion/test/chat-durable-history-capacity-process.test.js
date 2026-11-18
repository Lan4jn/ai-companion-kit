import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {createHash,createHmac} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createMemoryBrain} from '../src/memory-brain-adapter.js';
import {EncryptedChatJournal} from '../src/chat-durable-journal-candidate.js';
import {DurableBatchCandidate,createBoundBatchProcessorCandidate} from '../src/chat-durable-batch-candidate.js';
import {initializeManagedStore} from '../src/memory-brain-trust.js';
import {Memory} from '../src/memory.js';

const worker=fileURLToPath(new URL('./fixtures/chat-history-capacity-process-worker.js',import.meta.url));
const ackWorker=fileURLToPath(new URL('./fixtures/chat-history-sigkill-worker.js',import.meta.url));
const scope=user=>({tenant:'companion',platform:'qq',type:'private',session:`private:${user}`,user});
const turn=id=>({turnId:`turn-${id}`,events:[`onebot-message:${id}`],text:`question-${id}`,reply:`answer-${id}`});
const store=directory=>createMemoryBrain({enabled:true,backend:'sqlite-fts',directory,maxChatHistoryTurns:1,authorize:async()=>true,recoveryAuthorization:async()=>true});
const temp=t=>{const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'capacity-process-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;};
const kill=(directory,mode,id='1',user='123')=>{const p=spawnSync(process.execPath,[worker,directory,mode,id,user],{encoding:'utf8',timeout:20000});assert.equal(p.signal,'SIGKILL',p.stderr);};

test('SIGKILL after committed history and forget: reopen preserves scope, duplicate and tombstone capacity',async t=>{
 const directory=path.join(temp(t),'store'),a=scope('123'),b=scope('456');
 kill(directory,'write-kill'); let s=store(directory);
 assert.deepEqual(await s.chatHistory(a),[turn('1')]);
 assert.equal(await s.commitChatHistory(a,turn('1')),'duplicate');
 await assert.rejects(s.commitChatHistory(a,turn('2')));
 assert.equal(await s.commitChatHistory(b,turn('2')),'inserted');
 kill(directory,'forget-kill'); s=store(directory);
 assert.deepEqual(await s.chatHistory(a),[]);
 assert.equal(await s.commitChatHistory(a,turn('1')),'forgotten');
 await assert.rejects(s.commitChatHistory(a,turn('2')));
 assert.deepEqual(await s.chatHistory(b),[turn('2')]);
});

test('independent processes racing for one scoped slot cannot both commit',async t=>{
 const directory=path.join(temp(t),'store');
 // Establish schema before the race so this exercises independent writers, not initialization.
 const s=store(directory);await s.forget(scope('123'),{source:'qq-private-message',evidence:'onebot-message:99'});
 const children=['1','2'].map(id=>spawn(process.execPath,[worker,directory,'race',id],{stdio:['pipe','pipe','pipe']}));
 const result=children.map(p=>new Promise((resolve,reject)=>{let out='',err='';p.stdout.on('data',x=>out+=x);p.stderr.on('data',x=>err+=x);p.on('error',reject);p.on('close',(code,signal)=>code===0?resolve(out.trim()):reject(Error(`${code} ${signal} ${err}`)));}));
 for(const p of children)p.stdin.end('go');
 assert.deepEqual((await Promise.all(result)).sort(),['inserted','rejected']);
 assert.equal((await s.chatHistory(scope('123'))).length,1);
});

test('full history retains signed acknowledgement across actual process death and repeated recovery',async t=>{
 let j; t.after(()=>j?.close());
 const dir=temp(t),directory=path.join(dir,'store'),journalDir=path.join(dir,'journal'),a=scope('123');
 fs.mkdirSync(journalDir,{mode:0o700});initializeManagedStore(directory);
 const s=store(directory);
 const fullDir=path.join(temp(t),'store');initializeManagedStore(fullDir);const full=store(fullDir);
 assert.equal(await full.commitChatHistory(a,turn('9')),'inserted');
 await assert.rejects(full.reserveChatHistory(a,turn('1')));
 assert.deepEqual(await full.chatHistory(a),[turn('9')]);
 const child=spawnSync(process.execPath,[ackWorker,dir,'after-ack-capacity'],{encoding:'utf8',timeout:20000});assert.equal(child.signal,'SIGKILL',child.stderr);
 // Only this test-created journal lock is removed, after the child has been reaped.
 fs.rmdirSync(path.join(journalDir,'.journal.lock'));
 j=new EncryptedChatJournal({directory:journalDir,key:Buffer.alloc(32,31)});
 const session='transport-bound-v1:'+createHash('sha256').update(JSON.stringify(['onebot-qq',a.session])).digest('hex');
 const sealKey=createHmac('sha256',j.key).update('main-local-onebot-seal-v1').digest();let sends=0;
 const reopen=()=>{const q=new DurableBatchCandidate(j);return {q,d:createBoundBatchProcessorCandidate({enabled:true,queue:q,bot:{},sender:{send:async()=>{sends++;throw Error('must not send');}},sealKey,ownerId:'123',retainAcknowledged:true})};};
 let {q,d}=reopen();const before=structuredClone(q.list(session)[0]);assert.equal(before.state,'history-pending');
 assert.equal(await s.requireChatHistoryCapacity(a).then(()=>true,()=>false),false);
 assert.equal(await d.recordHistory(session,new Memory({dir:path.join(dir,'memory')}),{store:s,scope:a}),'inserted');
 assert.equal(q.list(session).length,0);assert.deepEqual(await s.chatHistory(a),[{turnId:'fixture',events:['onebot-message:1'],text:'synthetic question',reply:'firstsecond'}]);
 j.close();j=new EncryptedChatJournal({directory:journalDir,key:Buffer.alloc(32,31)});({q,d}=reopen());
 assert.equal(q.list(session).length,0);assert.equal((await d.process(session)).status,'blocked');
 assert.equal(sends,0);assert.equal(fs.readFileSync(path.join(dir,'sends'),'utf8'),'first\nsecond\n');
});
