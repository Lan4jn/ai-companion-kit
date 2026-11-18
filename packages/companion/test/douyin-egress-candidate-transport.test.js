import test from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readCandidatePage } from '../src/douyin-egress-candidate-transport.js';

// Run ONLY in a disposable network namespace with 8.8.8.8 bound to loopback.
test('pinned TLS transport contacts the validated address and rejects mixed DNS and redirects', {skip: process.env.DOUYIN_TEST_NETNS !== '1', timeout: 20000}, async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'douyin-tls-fixture-'));
  let server;
  try {
    const key=path.join(dir,'key.pem'), cert=path.join(dir,'cert.pem');
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=www.douyin.com','-addext','subjectAltName=DNS:www.douyin.com'],{stdio:'ignore'});
    let hits=0, redirect=false;
    server=https.createServer({key:fs.readFileSync(key),cert:fs.readFileSync(cert)}, (req,res)=>{
      hits++;
      if (redirect) {res.writeHead(302,{location:'http://127.0.0.1/'}); res.end();}
      else {res.writeHead(200,{'content-type':'text/plain'}); res.end('synthetic');}
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'8.8.8.8',resolve)});
    const ca=fs.readFileSync(cert), port=server.address().port;
    const lookup=async()=>[{address:'8.8.8.8',family:4}];
    // Dependency injection for test port and trust roots does not change the URL policy.
    const result=await readCandidatePage('https://www.douyin.com/',{lookup,port,ca});
    assert.equal(result.body.toString(),'synthetic'); assert.equal(hits,1);
    await assert.rejects(readCandidatePage('https://www.douyin.com/',{lookup:async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}],port,ca}));
    await assert.rejects(readCandidatePage('https://www.douyin.com/',{lookup,port,ca:tls.rootCertificates}));
    assert.equal(hits,1);
    redirect=true;
    await assert.rejects(readCandidatePage('https://www.douyin.com/',{lookup,port,ca}));
    assert.equal(hits,2);
    await assert.rejects(readCandidatePage('https://www.douyin.com/other',{lookup,port,ca}));
    assert.equal(hits,2);
  } finally { if(server) await new Promise(resolve=>server.close(resolve)); fs.rmSync(dir,{recursive:true,force:true}); }
});
