#!/usr/bin/env node
// Explicit one-shot local recovery; no configuration, discovery or startup replay.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {checkKeyParent,loadKey} from '../src/chat-durable-runtime-candidate.js';
import {EncryptedChatJournal} from '../src/chat-durable-journal-candidate.js';
import {DurableBatchCandidate} from '../src/chat-durable-batch-candidate.js';
import {inspectTrustedRecovery,sendTrustedRecovery} from '../src/chat-trusted-recovery.js';
import {createManagedMemoryBrain} from '../src/memory-brain-trust.js';
let journal, key, seal;
try {
 const [command,...args]=process.argv.slice(2), opts={};
 for(let i=0;i<args.length;i++) { const flag=args[i]; if(!flag.startsWith('--') || Object.hasOwn(opts,flag)) throw Error('arguments'); if(flag==='--confirm-one-segment') opts[flag]=true; else {if(!args[i+1] || args[i+1].startsWith('--')) throw Error('arguments'); opts[flag]=args[++i];} }
 const allowed=command==='inspect'?['--directory','--key']:command==='send'?['--directory','--key','--seal-key','--owner','--socket','--id','--snapshot','--store-directory','--confirm-one-segment']:[];
 if(!allowed.length || Object.keys(opts).some(k=>!allowed.includes(k)) || allowed.some(k=>!opts[k])) throw Error('arguments');
 const dir=opts['--directory']; if(!path.isAbsolute(dir)) throw Error('directory');
 checkKeyParent(path.join(dir,'journal.enc'));
 const st=fs.lstatSync(path.join(dir,'journal.enc')); if(!st.isFile() || st.isSymbolicLink()) throw Error('journal');
 if(fs.readdirSync(dir).some(n=>n.startsWith('.journal-'))) throw Error('unfinished journal');
 key=loadKey(opts['--key']); journal=new EncryptedChatJournal({directory:dir,key}); key.fill(0); key=null;
 const queue=new DurableBatchCandidate(journal);
 if(command==='inspect') console.log(JSON.stringify(inspectTrustedRecovery(queue)));
 else {
  seal=loadKey(opts['--seal-key']); const socket=opts['--socket']; checkKeyParent(socket);
  const s=fs.lstatSync(socket); if(!s.isSocket() || s.isSymbolicLink() || s.uid!==process.getuid() || (s.mode & 0o077)) throw Error('unsafe socket');
  const row=inspectTrustedRecovery(queue).find(r=>r.id===opts['--id']);
  if(!row || row.snapshot!==opts['--snapshot']) throw Error('stale selection');
  const bot={send:(destination,segment)=>new Promise((resolve,reject)=>{
   const conn=net.createConnection(socket); let response='',finished=false;
   const end=(err,value)=>{if(finished)return;finished=true;conn.destroy();err?reject(err):resolve(value)};
   conn.setTimeout(5000,()=>end(Error('timeout'))); conn.on('error',end); conn.on('connect',()=>conn.write(JSON.stringify({destination,segment})+'\n'));
   conn.on('data',chunk=>{response+=chunk.toString('utf8'); if(Buffer.byteLength(response)>4096)return end(Error('response too large')); if(response.includes('\n')) {try {const v=JSON.parse(response.slice(0,response.indexOf('\n')));end(null,v)} catch(e){end(e)}}});
   conn.on('end',()=>end(Error('connection closed')));
  })};
  const owner=opts['--owner']; if(!/^[1-9]\d*$/.test(owner)) throw Error('invalid owner');
  const scope={tenant:'companion',platform:'qq',type:'private',session:`private:${owner}`,user:owner};
  const store=createManagedMemoryBrain({directory:opts['--store-directory'],scope,sources:['qq-private-message'],trustedProcess:true,backend:'sqlite-fts'});
  const result=await sendTrustedRecovery({queue,bot,sealKey:seal,ownerId:owner,store,scope,...row});
  console.log(JSON.stringify({status:result.status})); if(result.status!=='delivered') process.exitCode=2;
 }
} catch { console.error('Recovery refused; inspect arguments, permissions, lock, keys and journal offline.'); process.exitCode=1; }
finally { if(key)key.fill(0); if(seal)seal.fill(0); if(journal)try{journal.close()}catch{process.exitCode=1;console.error('Lock cleanup failed; investigate offline.')} }
