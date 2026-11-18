import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createCandidateBroker} from '../src/douyin-request-broker-candidate.js';

async function withBroker(fn) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dy-broker-stall-'));
  const socketPath=path.join(dir,'s');
  const broker=createCandidateBroker({token:'a'.repeat(64)});
  let client;
  try {
    await new Promise((resolve,reject)=>broker.server.once('error',reject).listen(socketPath,resolve));
    client=net.createConnection(socketPath);
    await new Promise((resolve,reject)=>{client.once('connect',resolve);client.once('error',reject);});
    await fn(client);
  } finally {client?.destroy();await broker.close();fs.rmSync(dir,{recursive:true,force:true});}
}
const header = length => 'POST /request HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer '+ 'a'.repeat(64)+`\r\nContent-Length: ${length}\r\n\r\n`;

test('broker terminates a slowly trickled request envelope', {timeout:9000}, async () => {
  await withBroker(async client => {
    const closed=new Promise(resolve=>client.once('close',()=>resolve(true)));
    client.write(header(100)+'{');
    const trickle=setInterval(()=>{if(!client.destroyed)client.write(' ');},500);
    try {assert.equal(await Promise.race([closed,new Promise(resolve=>setTimeout(()=>resolve(false),6500))]),true,'incomplete upload held broker open');}
    finally {clearInterval(trickle);}
  });
});

test('broker terminates an oversized request envelope', {timeout:4000}, async () => {
  await withBroker(async client => {
    const closed=new Promise(resolve=>client.once('close',()=>resolve(true)));
    client.write(header(20000)+'x'.repeat(17000));
    assert.equal(await Promise.race([closed,new Promise(resolve=>setTimeout(()=>resolve(false),2000))]),true,'oversized upload held broker open');
  });
});
