import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createCandidateBroker} from '../src/douyin-request-broker-candidate.js';

test('pipelined partial headers in the same packet retain a deadline', {timeout:8000}, async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'broker-pipeline-'));
  const broker=createCandidateBroker({token:'a'.repeat(64)}); broker.server.keepAliveTimeout=0; let c;
  try {
    const sock=path.join(dir,'s'); await new Promise(r=>broker.server.listen(sock,r));
    c=net.createConnection(sock); c.on('error',()=>{}); c.resume();
    await new Promise(r=>c.once('connect',r));
    const closed=new Promise(r=>c.once('close',()=>r(true)));
    const first='POST /request HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer '+ 'a'.repeat(64)+'\r\nContent-Length: 2\r\n\r\n{}';
    c.write(first+'POST /request HTTP/1.1\r\nHost: localhost\r\nX-Slow: ');
    assert.equal(await Promise.race([closed,new Promise(r=>setTimeout(()=>r(false),6500))]),true,'coalesced next header held stream open');
  } finally {c?.destroy();await broker.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('partial headers have a wall clock deadline despite trickled bytes', {timeout:8000}, async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'broker-header-'));
  const broker=createCandidateBroker({token:'a'.repeat(64)}); let c,interval;
  try {
    const sock=path.join(dir,'s'); await new Promise(r=>broker.server.listen(sock,r));
    c=net.createConnection(sock); c.on('error',()=>{}); await new Promise(r=>c.once('connect',r));
    const closed=new Promise(r=>c.once('close',()=>r(true)));
    c.write('POST /request HTTP/1.1\r\nHost: localhost\r\nX-Slow: ');
    interval=setInterval(()=>{if(!c.destroyed)c.write('a');},300);
    assert.equal(await Promise.race([closed,new Promise(r=>setTimeout(()=>r(false),6500))]),true);
  } finally {clearInterval(interval);c?.destroy();await broker.close();fs.rmSync(dir,{recursive:true,force:true});}
});
