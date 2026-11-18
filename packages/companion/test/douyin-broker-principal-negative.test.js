// Synthetic-only privilege experiment. No production service or credentials.
// Run in a disposable network namespace: DOUYIN_TEST_NETNS=1 node --test ...
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import {execFileSync, spawn} from 'node:child_process';
import {createCandidateBroker} from '../src/douyin-request-broker-candidate.js';

function run(uid, source, args = []) {
  return new Promise((resolve,reject) => {
    const p = spawn('setpriv',['--reuid',String(uid),'--regid',String(uid),'--clear-groups','node','-e',source,...args]);
    let out=''; p.stdout.on('data',d=>out+=d); p.stderr.on('data',d=>out+=d);
    p.on('error',reject); p.on('close',code=>resolve({code,out}));
  });
}

test('separate UID socket boundary and same-UID capability theft negative control', {skip:process.env.DOUYIN_TEST_NETNS!=='1',timeout:30000}, async()=>{
  assert.equal(process.getuid(),0,'requires root inside a disposable network namespace');
  // /root and the normal scratch directory are intentionally not traversable by
  // the unprivileged UID. Use a dedicated, root-owned traversal-only directory.
  const root=fs.mkdtempSync('/run/douyin-broker-principal-'); let fixture,broker,victim; const hits=[];
  try {
    // 65534 is the untrusted browser principal. Root owns broker and TLS fixture.
    fs.chmodSync(root,0o711);
    const key=path.join(root,'key'),cert=path.join(root,'cert'),sock=path.join(root,'broker.sock'),secret='c'.repeat(64);
    execFileSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=www.douyin.com','-addext','subjectAltName=DNS:www.douyin.com'],{stdio:'ignore'});
    execFileSync('ip',['addr','add','8.8.8.8/32','dev','lo']);
    fixture=https.createServer({key:fs.readFileSync(key),cert:fs.readFileSync(cert)},(q,r)=>{hits.push([q.method,q.url]);r.end('synthetic');});
    await new Promise(r=>fixture.listen(0,'8.8.8.8',r));
    broker=createCandidateBroker({token:secret,fixturePolicy:(m,u)=>m==='GET'&&u==='https://www.douyin.com/',transportOptions:{port:fixture.address().port,ca:fs.readFileSync(cert),lookup:async()=>[{address:'8.8.8.8',family:4}]}});
    await new Promise(r=>broker.server.listen(sock,r));
    fs.chmodSync(sock,0o600);
    const connect="const net=require('net');let s=net.connect(process.argv[1]);s.on('connect',()=>{console.log('CONNECTED');s.destroy()});s.on('error',e=>{console.log(e.code);process.exitCode=2})";
    fs.chmodSync(key,0o600);
    const deniedFiles=await run(65534,"const fs=require('fs');for(const [op,p] of [['read',process.argv[1]],['write',process.argv[2]]]){try{op==='read'?fs.readFileSync(p):fs.writeFileSync(p,'x');process.exit(3)}catch(e){if(e.code!=='EACCES')process.exit(4)}}",[key,path.join(root,'attacker-file')]);
    assert.equal(deniedFiles.code,0,deniedFiles.out);
    const denied=await run(65534,connect,[sock]); assert.equal(denied.code,2,denied.out); assert.match(denied.out,/EACCES/);
    // Deliberately relax ACL for the negative control: a process holding a token
    // in argv is readable by a same-UID process. Capability alone is not identity.
    fs.chmodSync(sock,0o666);
    victim=spawn('setpriv',['--reuid','65534','--regid','65534','--clear-groups','node','-e','setInterval(()=>{},1000)',secret],{stdio:'ignore'});
    await new Promise(r=>setTimeout(r,300)); assert.equal(victim.exitCode,null);
    const attack=`const fs=require('fs'),http=require('http');const a=fs.readFileSync('/proc/'+process.argv[1]+'/cmdline').toString().split('\\0');const token=a.find(x=>/^[c]{64}$/.test(x));if(!token)process.exit(3);const q=http.request({socketPath:process.argv[2],method:'POST',path:'/request',headers:{authorization:'Bearer '+token,'content-type':'application/json'}},r=>{console.log(r.statusCode);r.resume()});q.on('error',e=>{console.error(e);process.exitCode=4});q.end(JSON.stringify({method:'GET',url:'https://www.douyin.com/',headers:{}}));`;
    const stolen=await run(65534,attack,[String(victim.pid),sock]); assert.equal(stolen.code,0,stolen.out);assert.match(stolen.out,/200/);assert.deepEqual(hits,[['GET','/']]);
  } finally {victim?.kill('SIGKILL');await broker?.close();if(fixture)await new Promise(r=>fixture.close(r));fs.rmSync(root,{recursive:true,force:true});}
});
