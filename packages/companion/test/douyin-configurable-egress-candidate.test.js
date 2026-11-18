import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import {execFileSync} from 'node:child_process';
import {createRestrictedEgress} from '../src/douyin-configurable-egress-candidate.js';

test('default deny and exact host/method/path authorization', async () => {
  const empty=createRestrictedEgress();
  assert.equal(empty.authorize('GET','https://www.douyin.com/'),false);
  const p=createRestrictedEgress({hosts:['login.example.test'],routes:[{host:'login.example.test',method:'GET',path:'/login'}]});
  assert.equal(p.authorize('GET','https://login.example.test/login?a=1'),true);
  for(const u of ['http://login.example.test/login','wss://login.example.test/login','https://login.example.test.evil/login','https://login.example.test@evil.test/login','https://login.example.test:444/login','https://login.example.test/%6cogin','https://login.example.test/a/../login','https://login.example.test/login#x','https://login.example.test/other']) assert.equal(p.authorize('GET',u),false,u);
  assert.equal(p.authorize('POST','https://login.example.test/login'),false);
});

test('DNS rejects mixed and nonpublic answers',async()=>{
 const p=createRestrictedEgress({hosts:['login.example.test'],routes:[{host:'login.example.test',method:'GET',path:'/login'}]});
 for(const ip of ['127.0.0.1','169.254.169.254','10.0.0.1','::1','::ffff:8.8.8.8']) await assert.rejects(p.resolve('login.example.test',async()=>[{address:'8.8.8.8',family:4},{address:ip,family:ip.includes(':')?6:4}]));
 assert.equal((await p.resolve('login.example.test',async()=>[{address:'8.8.8.8',family:4}])).address,'8.8.8.8');
});

test('real TLS pinned transport reauthorizes redirects and prevents uploads to other hosts', {skip:process.env.DOUYIN_TEST_NETNS !== '1'}, async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'candidate-tls-')); let server;
 try {
  const key=path.join(dir,'key'),cert=path.join(dir,'cert');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=login.example.test','-addext','subjectAltName=DNS:login.example.test'],{stdio:'ignore'});
  let hits=[];
  server=https.createServer({key:fs.readFileSync(key),cert:fs.readFileSync(cert)},(req,res)=>{
   hits.push(req.url);
   if(req.url==='/login') {res.writeHead(302,{location:'/done'});res.end();}
   else if(req.url==='/evil') {res.writeHead(302,{location:'https://evil.test/done'});res.end();}
   else if(req.url==='/dot') {res.writeHead(302,{location:'/x/../done'});res.end();}
   else res.end('synthetic');
  });
  await new Promise((ok,fail)=>{server.once('error',fail);server.listen(0,'8.8.8.8',ok)});
  const p=createRestrictedEgress({hosts:['login.example.test'],routes:['/login','/done','/evil','/dot'].map(path=>({host:'login.example.test',method:'GET',path}))});
  let resolutions=0; const options={lookup:async()=>{resolutions++;return [{address:'8.8.8.8',family:4}]},port:server.address().port,ca:fs.readFileSync(cert)};
  assert.equal((await p.request({url:'https://login.example.test/login'},options)).body.toString(),'synthetic');
  assert.deepEqual(hits,['/login','/done']); assert.equal(resolutions,2);
  await assert.rejects(p.request({url:'https://login.example.test/evil'},options));
  await assert.rejects(p.request({url:'https://login.example.test/dot'},options));
  await assert.rejects(p.request({url:'https://login.example.test/done'}, {...options,ca:undefined}));
  await assert.rejects(p.request({url:'https://login.example.test/done',method:'POST',body:Buffer.from('synthetic')},options));
  await assert.rejects(p.request({url:'https://login.example.test/done'}, {...options,maxBytes:2}));
  let call=0;
  await assert.rejects(p.request({url:'https://login.example.test/login'}, {...options,lookup:async()=>++call===1?[{address:'8.8.8.8',family:4}]:[{address:'127.0.0.1',family:4}]}));
  assert.equal(call,2);
  assert.deepEqual(hits,['/login','/done','/evil','/dot','/done','/login']);
 } finally {if(server) await new Promise(ok=>server.close(ok));fs.rmSync(dir,{recursive:true,force:true});}
});
