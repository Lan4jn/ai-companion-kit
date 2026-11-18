// Isolated, opt-in local candidate; not wired to production or startup replay.
// The process owns the journal lock and an independently authenticated OneBot bot.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {checkKeyParent} from './chat-durable-runtime-candidate.js';
import {DurableBatchCandidate} from './chat-durable-batch-candidate.js';
import {inspectTrustedRecovery,sendTrustedRecovery} from './chat-trusted-recovery.js';
import {verifyBridgeSelector} from './chat-onebot-queue-selector.js';

export async function startTrustedSenderCandidate({enabled=false,queue,bot,sealKey,ownerId,socket,selectorKey,store,scope}={}) {
 if (selectorKey !== undefined && (!Buffer.isBuffer(selectorKey) || selectorKey.length!==32)) throw Error('invalid selector key');
 if (enabled!==true) throw Error('trusted sender disabled');
 if (!(queue instanceof DurableBatchCandidate) || !bot || typeof bot.send!=='function' || !Buffer.isBuffer(sealKey) || sealKey.length!==32 || typeof ownerId!=='string' || !/^[1-9]\d*$/.test(ownerId)) throw Error('invalid trusted sender');
 checkKeyParent(socket);
 const parent=fs.lstatSync(path.dirname(socket));
 if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid!==process.getuid() || (parent.mode & 0o077)) throw Error('private socket directory required');
 try { fs.lstatSync(socket); throw Error('socket path occupied'); } catch(e) {if(e.code!=='ENOENT') throw e;}
 queue.validate();
 const key=Buffer.from(sealKey), selectorSecret=selectorKey && Buffer.from(selectorKey); const clients=new Set(); let busy=false,closing=false,ready=false,active=null,created;
 const server=net.createServer(conn=>{
  if (!ready || closing || clients.size>=8) {conn.destroy();return;}
  clients.add(conn); conn.on('close',()=>clients.delete(conn)); conn.on('error',()=>{});
  conn.setTimeout(5000,()=>conn.destroy()); let buffer=Buffer.alloc(0),handled=false;
  conn.on('data',chunk=>{
   if (handled) {conn.destroy();return;}
   buffer=Buffer.concat([buffer,chunk]);
   if (buffer.length>4096) {conn.destroy();return;}
   const nl=buffer.indexOf(10);if(nl<0)return;
   handled=true;
   const reply=status=>{if(!conn.destroyed)conn.end(JSON.stringify({status})+'\n');};
   if(nl!==buffer.length-1) {reply('blocked');return;}
   let request;try {request=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,nl)));}catch {reply('blocked');return;}
   if(selectorSecret) request=verifyBridgeSelector(selectorSecret,request);
   if (!request || typeof request!=='object' || Array.isArray(request) || Object.keys(request).sort().join(',')!=='confirm,id,snapshot' || request.confirm!==true || typeof request.id!=='string' || typeof request.snapshot!=='string' || !/^[a-f0-9]{64}$/.test(request.snapshot) || busy || closing) {reply('blocked');return;}
   busy=true;
   active=(async()=>{
    try {
     const row=inspectTrustedRecovery(queue).find(r=>r.id===request.id);
     if(!row || row.snapshot!==request.snapshot) {reply('blocked');return;}
     const result=await sendTrustedRecovery({queue,bot,sealKey:key,ownerId,store,scope,...row});
     reply(['delivered','blocked','unknown'].includes(result.status)?result.status:'unknown');
    } catch {reply('unknown');}
    finally {busy=false;active=null;}
   })();
  });
 });
 try {
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socket,()=>{server.removeListener('error',reject);resolve();});});
  created=fs.lstatSync(socket); if(!created.isSocket() || created.uid!==process.getuid()) throw Error('unsafe socket');
  fs.chmodSync(socket,0o600);const actual=fs.lstatSync(socket);
  if(actual.dev!==created.dev || actual.ino!==created.ino || (actual.mode & 0o777)!==0o600) throw Error('unsafe socket');
  server.on('error',()=>{}); ready=true;
 } catch(e) {if(server.listening)await new Promise(r=>server.close(r));if(created)try{const st=fs.lstatSync(socket);if(st.dev===created.dev&&st.ino===created.ino)fs.unlinkSync(socket);}catch{} key.fill(0);selectorSecret?.fill(0);throw e;}
 return Object.freeze({async close(){
  if(closing)return;closing=true;ready=false;
  const stopped=new Promise(resolve=>server.close(resolve));for(const conn of clients)conn.destroy();
  if(active) await active;await stopped;
  try{const st=fs.lstatSync(socket);if(st.dev===created.dev && st.ino===created.ino)fs.unlinkSync(socket);}catch(e){if(e.code!=='ENOENT')throw e;}finally{key.fill(0);selectorSecret?.fill(0);}
 }});
}
