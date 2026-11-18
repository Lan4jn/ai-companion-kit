import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createConnection} from 'node:net';
import {ChatBatchQueue} from '../src/chat-batch-queue.js';
import {startChatRecovery} from '../src/chat-recovery.js';
const request=(path,msg)=>new Promise((resolve,reject)=>{const s=createConnection(path);let data='';s.on('connect',()=>s.end(JSON.stringify(msg)+'\n'));s.on('data',c=>data+=c);s.on('end',()=>resolve(JSON.parse(data)));s.on('error',reject)});
test('private fingerprint and attempt time identify separate sessions; resolution acknowledges without awaiting later work',async()=>{
 const base=await mkdtemp(join(tmpdir(),'chat-op-')); let release; const gate=new Promise(r=>release=r); let calls=0;
 const q=new ChatBatchQueue({waker:{},run:async items=>{if(items[0].text==='later'){await gate;return {ok:true}} calls++;return {ok:false}}});
 q.enqueue([{key:'private:alice',text:'SECRET'}]);q.enqueue([{key:'private:alice',text:'later'}]);q.enqueue([{key:'private:bob',text:'OTHER'}]);await Promise.all([...q.chains.values()]);
 const server=await startChatRecovery(q,{directory:join(base,'control')});
 try {const a=await request(server.path,{action:'list'}), b=await request(server.path,{action:'list'});assert.equal(a.entries.length,2);assert.deepEqual(a,b);assert.notEqual(a.entries[0].sessionFingerprint,a.entries[1].sessionFingerprint);assert.match(a.entries[0].sessionFingerprint,/^[a-f0-9]{24}$/);assert.ok(Number.isFinite(Date.parse(a.entries[0].attemptedAt)));assert.doesNotMatch(JSON.stringify(a),/alice|bob|SECRET|OTHER|later/);assert.equal((await lstat(server.path)).mode & 0o777,0o600);
 const result=await Promise.race([request(server.path,{action:'resolve',id:a.entries[0].id,decision:'discard'}),new Promise((_,reject)=>setTimeout(()=>reject(new Error('ack blocked by later turn')),1000))]);assert.equal(result.ok,true);
 }finally{release();await Promise.all([...q.chains.values()]);await server.close();await rm(base,{recursive:true,force:true});}
});
