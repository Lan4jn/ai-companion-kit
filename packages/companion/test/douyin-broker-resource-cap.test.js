import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createCandidateBroker} from '../src/douyin-request-broker-candidate.js';

test('pipelined response backlog is bounded even before HTTP dispatch', {timeout:4000}, async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'broker-pipeline-cap-'));
  const broker=createCandidateBroker({token:'a'.repeat(64), policy:{hosts:['www.douyin.com'],routes:[{host:'www.douyin.com',method:'GET',path:'/'}]}, transportOptions:{lookup:()=>new Promise(()=>{})}}); let c;
  try {
    const sock=path.join(dir,'s'); await new Promise(r=>broker.server.listen(sock,r));
    c=net.createConnection(sock); c.on('error',()=>{}); c.resume();
    await new Promise(r=>c.once('connect',r));
    const closed=new Promise(r=>c.once('close',()=>r(true)));
    const body=JSON.stringify({url:'https://www.douyin.com/',method:'GET',headers:{}});
    const slow='POST /request HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer '+ 'a'.repeat(64)+`\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n`+body;
    const request='POST /request HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer '+ 'a'.repeat(64)+'\r\nContent-Length: 2\r\n\r\n{}';
    c.write(slow); await new Promise(r=>setTimeout(r,100));
    c.write(request.repeat(5));
    assert.equal(await Promise.race([closed,new Promise(r=>setTimeout(()=>r(false),1500))]),true,'pipelined backlog held stream open');
  } finally {c?.destroy();await broker.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('broker bounds simultaneous connections including incomplete headers', {timeout:5000}, async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'broker-cap-'));
  const broker=createCandidateBroker({token:'a'.repeat(64)}), clients=[];
  try {
    const sock=path.join(dir,'s');
    await new Promise((resolve,reject)=>broker.server.once('error',reject).listen(sock,resolve));
    for (let i=0;i<20;i++) {
      const c=net.createConnection(sock); clients.push(c); c.on('error',()=>{});
      await new Promise(resolve=>c.once('connect',resolve));
      c.write('POST /request HTTP/1.1\r\nHost: local\r\nX-Slow: ');
    }
    await new Promise(resolve=>setTimeout(resolve,200));
    assert.ok(clients.filter(c=>!c.destroyed).length <= 8, 'unbounded concurrent sockets');
  } finally { for(const c of clients)c.destroy(); await broker.close(); fs.rmSync(dir,{recursive:true,force:true}); }
});
