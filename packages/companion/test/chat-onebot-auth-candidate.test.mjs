import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startOneBotQueueBridge} from '../src/chat-onebot-queue-bridge.js';
import {createAuthenticatedOneBotSender} from '../src/chat-onebot-authenticated-sender.js';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {X509Certificate} from 'node:crypto';

test('caller assertion cannot authenticate OneBot connection', async () => {
  await assert.rejects(startOneBotQueueBridge({enabled:true,connectionIsAuthenticated:true,bot:{send(){}},selectorKey:Buffer.alloc(32,1),sealKey:Buffer.alloc(32,2)}), /authenticated OneBot sender required/);
});

test('pinned TLS endpoint enforces peer identity and owner-only sends', async t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'onebot-auth-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const key=path.join(dir,'key.pem'), cert=path.join(dir,'cert.pem');
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],{stdio:'ignore'});
 const ca=fs.readFileSync(cert), pin=new X509Certificate(ca).fingerprint256.replaceAll(':','').toLowerCase();
 let received=0;
 const server=https.createServer({key:fs.readFileSync(key),cert:ca},(req,res)=>{received++;req.resume();req.on('end',()=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({status:'ok',retcode:0}));});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>server.close(r)));
 const port=server.address().port, url=`https://localhost:${port}/`, options={url,ca,certificateSha256:pin,ownerId:'123'};
 const sender=createAuthenticatedOneBotSender(options);
 assert.equal((await sender.send('private:999','hello')).ok,false);
 assert.equal((await sender.send('private:123','[CQ:at,qq=1]')).ok,false);
 assert.equal((await createAuthenticatedOneBotSender({...options,certificateSha256:'00'.repeat(32)}).send('private:123','hello')).ok,false);
 assert.equal((await createAuthenticatedOneBotSender({...options,url:`https://127.0.0.1:${port}/`}).send('private:123','hello')).ok,false);
 assert.equal(received,0);
 assert.equal((await sender.send('private:123','hello')).ok,true);
 assert.equal(received,1);
 assert.throws(()=>createAuthenticatedOneBotSender({...options,url:'http://localhost/'}),/invalid authenticated endpoint/);
});
