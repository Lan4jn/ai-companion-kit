// Explicit local service candidate; no automatic replay or production integration.
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import tls from 'node:tls';
import {createHash, timingSafeEqual} from 'node:crypto';
import {checkKeyParent, loadKey} from './chat-durable-runtime-candidate.js';
import {EncryptedChatJournal} from './chat-durable-journal-candidate.js';
import {DurableBatchCandidate} from './chat-durable-batch-candidate.js';
import {startTrustedSenderCandidate} from './chat-trusted-sender-candidate.js';
import {createOneBotUnixSender} from './chat-onebot-unix-sender.js';

function tokenFromFile(file) {
 checkKeyParent(file);
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 try {
  const st=fs.fstatSync(fd);
  if(!st.isFile() || st.uid!==process.getuid() || st.nlink!==1 || (st.mode&0o077) || st.size<16 || st.size>512) throw Error('unsafe token');
  const token=fs.readFileSync(fd,'utf8');
  if(!/^[A-Za-z0-9._~-]{16,512}$/.test(token)) throw Error('invalid token');
  return token;
 } finally {fs.closeSync(fd);}
}

// A pinned certificate is mandatory and checked on each fresh TLS connection,
// before any request bytes (including bearer token) are written.
function oneBot(endpoint,token) {
 const expected=Buffer.from(endpoint.certificateSha256,'hex');
 const agent=new https.Agent({keepAlive:false,maxSockets:1});
 agent.createConnection=(options,callback)=>{
  const socket=tls.connect({host:'127.0.0.1',port:endpoint.port,rejectUnauthorized:false});
  let finished=false;
  const fail=()=>{if(finished)return;finished=true;socket.destroy();callback(Error('endpoint identity unavailable'));};
  socket.setTimeout(5000,fail);socket.once('error',fail);
  socket.once('secureConnect',()=>{
   const cert=socket.getPeerCertificate(true);
   const digest=cert?.raw && createHash('sha256').update(cert.raw).digest();
   if(!digest || !timingSafeEqual(expected,digest)) return fail();
   if(finished)return;finished=true;socket.setTimeout(0);socket.removeListener('error',fail);callback(null,socket);
  });
 };
 return {async send(destination,segment) {
  if(!/^private:[1-9]\d*$/.test(destination)) throw Error('invalid destination');
  const body=JSON.stringify({user_id:destination.slice(8),message:[{type:'text',data:{text:segment}}]});
  return new Promise((resolve,reject)=>{
   let done=false;const finish=(err,value)=>{if(done)return;done=true;err?reject(err):resolve(value);};
   const req=https.request({host:'127.0.0.1',port:endpoint.port,path:'/send_private_msg',method:'POST',agent,headers:{authorization:`Bearer ${token}`,'content-type':'application/json','content-length':Buffer.byteLength(body)}},res=>{
    let chunks=[],size=0;res.on('data',chunk=>{size+=chunk.length;if(size>65536){res.destroy();finish(Error('response too large'));}else chunks.push(chunk);});
    res.on('error',()=>finish(Error('response failed')));
    res.on('end',()=>{try{if(res.statusCode!==200)throw Error();const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));finish(null,{ok:true,data});}catch{finish(Error('invalid response'));}});
   });
   req.setTimeout(5000,()=>req.destroy(Error('timeout')));req.on('error',()=>finish(Error('request failed')));req.end(body);
  });
 },close(){agent.destroy();}};
}

export async function startTrustedSenderService({enabled=false,directory,keyPath,sealKeyPath,ownerId,socket,endpoint,store,scope}={}) {
 if(enabled!==true) throw Error('trusted sender service disabled');
 const unix=endpoint && Object.keys(endpoint).sort().join(',')==='unixSocketPath' && typeof endpoint.unixSocketPath==='string';
 if(!unix && (!endpoint || endpoint.host!=='127.0.0.1' || !Number.isInteger(endpoint.port) || endpoint.port<1 || endpoint.port>65535 || !/^[a-f0-9]{64}$/.test(endpoint.certificateSha256||'') || Object.hasOwn(endpoint,'unixSocketPath'))) throw Error('endpoint identity evidence required');
 if(typeof ownerId!=='string' || !/^[1-9]\d*$/.test(ownerId)) throw Error('owner required');
 if(typeof directory!=='string' || !path.isAbsolute(directory)) throw Error('directory required');
 checkKeyParent(path.join(directory,'journal.enc'));
 const st=fs.lstatSync(path.join(directory,'journal.enc'));
 if(!st.isFile() || st.isSymbolicLink() || fs.readdirSync(directory).some(n=>n.startsWith('.journal-'))) throw Error('journal inspection required');
 const token=unix?null:tokenFromFile(endpoint.tokenPath);let key,seal,journal,bot,service;
 try {
  key=loadKey(keyPath);seal=loadKey(sealKeyPath);
  journal=new EncryptedChatJournal({directory,key});key.fill(0);key=null;
  const queue=new DurableBatchCandidate(journal);
  bot=unix?createOneBotUnixSender({socketPath:endpoint.unixSocketPath}):oneBot(endpoint,token);
  service=await startTrustedSenderCandidate({enabled:true,queue,bot,sealKey:seal,ownerId,socket,store,scope});
  seal.fill(0);seal=null;
  let closing;
  return Object.freeze({close(){return closing ||= (async()=>{try{await service.close();}finally{bot.close();journal.close();}})();}});
 } catch(e) {if(key)key.fill(0);if(seal)seal.fill(0);bot?.close();journal?.close();throw e;}
}
