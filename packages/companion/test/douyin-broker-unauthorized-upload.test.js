import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createCandidateBroker} from '../src/douyin-request-broker-candidate.js';

test('unauthorized incomplete upload cannot hold broker stream open', {timeout:4000}, async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dy-denied-'));
  const broker=createCandidateBroker({token:'a'.repeat(64)});
  let client;
  try {
    const socketPath=path.join(dir,'s');
    await new Promise((resolve,reject)=>broker.server.once('error',reject).listen(socketPath,resolve));
    client=net.createConnection(socketPath);
    await new Promise((resolve,reject)=>{client.once('connect',resolve);client.once('error',reject);});
    client.resume();
    const closed=new Promise(resolve=>client.once('close',()=>resolve(true)));
    client.write('POST /request HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer wrong\r\nContent-Length: 100000\r\n\r\nx');
    assert.equal(await Promise.race([closed,new Promise(resolve=>setTimeout(()=>resolve(false),1500))]),true);
  } finally {client?.destroy();await broker.close();fs.rmSync(dir,{recursive:true,force:true});}
});
