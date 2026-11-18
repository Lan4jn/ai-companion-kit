// OneBot v11 HTTP over a separately provisioned private Unix socket.
// Socket directory ownership is the trust anchor, not cryptographic peer identity.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {checkKeyParent} from './chat-durable-runtime-candidate.js';

export function createOneBotUnixSender({socketPath}={}) {
 checkKeyParent(socketPath);
 const parent=fs.lstatSync(path.dirname(socketPath));
 if(parent.uid!==process.getuid() || (parent.mode&0o077)) throw Error('private endpoint directory required');
 function checkSocket() {
  checkKeyParent(socketPath);
  const dir=fs.lstatSync(path.dirname(socketPath));
  const st=fs.lstatSync(socketPath);
  if(dir.uid!==process.getuid() || (dir.mode&0o077) || !st.isSocket() || st.uid!==process.getuid() || (st.mode&0o077)) throw Error('unsafe endpoint socket');
  return st;
 }
 const original=checkSocket();let closed=false;
 return Object.freeze({
  async send(destination,segment) {
   if(closed || !/^private:[1-9]\d*$/.test(destination) || typeof segment!=='string') throw Error('invalid request');
   const st=checkSocket();if(st.dev!==original.dev || st.ino!==original.ino) throw Error('endpoint changed');
   const body=JSON.stringify({user_id:destination.slice(8),message:[{type:'text',data:{text:segment}}]});
   return new Promise((resolve,reject)=>{
    let done=false;const finish=(err,value)=>{if(done)return;done=true;err?reject(err):resolve(value);};
    const req=http.request({socketPath,path:'/send_private_msg',method:'POST',agent:false,headers:{'content-type':'application/json','content-length':Buffer.byteLength(body)}},res=>{
     let size=0,chunks=[];res.on('data',chunk=>{size+=chunk.length;if(size>65536){res.destroy();finish(Error('response too large'));}else chunks.push(chunk);});
     res.on('error',()=>finish(Error('response failed')));
     res.on('end',()=>{try{if(res.statusCode!==200)throw Error();finish(null,{ok:true,data:JSON.parse(Buffer.concat(chunks).toString('utf8'))});}catch{finish(Error('invalid response'));}});
    });
    req.setTimeout(5000,()=>req.destroy());req.on('error',()=>finish(Error('request failed')));req.end(body);
   });
  },close(){closed=true;}
 });
}
