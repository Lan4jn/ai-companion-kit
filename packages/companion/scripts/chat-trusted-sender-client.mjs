#!/usr/bin/env node
// Manual selector for the separate journal-owning sender candidate.
import fs from 'node:fs';
import net from 'node:net';
import {checkKeyParent,loadKey} from '../src/chat-durable-runtime-candidate.js';
import {signBridgeSelector} from '../src/chat-onebot-queue-selector.js';
try {
 const [command,...args]=process.argv.slice(2),opts={};
 for(let i=0;i<args.length;i++) {const k=args[i];if(!k.startsWith('--') || Object.hasOwn(opts,k))throw Error('arguments');if(k==='--confirm-one-segment')opts[k]=true;else {if(!args[i+1] || args[i+1].startsWith('--'))throw Error('arguments');opts[k]=args[++i];}}
 const required=['--socket','--id','--snapshot','--confirm-one-segment'];
 if(command!=='send' || Object.keys(opts).some(k=>![...required,'--selector-key'].includes(k)) || required.some(k=>!opts[k]) || !/^[a-f0-9]{64}$/.test(opts['--snapshot']))throw Error('arguments');
 let request={id:opts['--id'],snapshot:opts['--snapshot'],confirm:true};
 if(opts['--selector-key']) {const key=loadKey(opts['--selector-key']);try{request=signBridgeSelector(key,request);}finally{key.fill(0);}}
 const socket=opts['--socket'];checkKeyParent(socket);const s=fs.lstatSync(socket);
 if(!s.isSocket() || s.isSymbolicLink() || s.uid!==process.getuid() || (s.mode & 0o077))throw Error('unsafe socket');
 const result=await new Promise((resolve,reject)=>{const c=net.createConnection(socket);let data=Buffer.alloc(0),done=false;
  const finish=(err,value)=>{if(done)return;done=true;c.destroy();err?reject(err):resolve(value)};
  c.setTimeout(5000,()=>finish(Error('timeout')));c.on('error',finish);c.on('connect',()=>c.write(JSON.stringify(request)+'\n'));
  c.on('data',chunk=>{data=Buffer.concat([data,chunk]);if(data.length>4096)return finish(Error('response'));const nl=data.indexOf(10);if(nl<0)return;if(nl!==data.length-1)return finish(Error('response'));try{const v=JSON.parse(data.subarray(0,nl).toString('utf8'));if(!v || Object.keys(v).join(',')!=='status' || !['delivered','blocked','unknown'].includes(v.status))throw Error('response');finish(null,v)}catch(e){finish(e)}});c.on('end',()=>finish(Error('closed')));
 });
 console.log(JSON.stringify(result));if(result.status!=='delivered')process.exitCode=2;
} catch {console.error('Request refused or outcome unavailable; inspect journal offline before any further action.');process.exitCode=1;}
