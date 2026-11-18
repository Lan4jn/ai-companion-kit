// Synthetic system-boundary experiment; never wired into production login.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import {spawn, execFileSync} from 'node:child_process';
import {createFixtureProxy} from './fixtures/douyin-netns-fixture-proxy.js';

const own = new URL(import.meta.url).pathname;
if (process.argv[2] === 'child') {
  const {chromium} = await import('playwright-core');
  const port=process.argv[3], spki=process.argv[4], privatePort=process.argv[5];
  // Probe the kernel boundary directly, independently of Chromium's proxy setting.
  const net=await import('node:net');
  for (const [host,targetPort] of [['8.8.8.8',443],['127.0.0.1',Number(privatePort)]]) {
    const outcome=await new Promise(resolve=>{const s=net.connect({host,port:targetPort});s.setTimeout(1500);s.on('connect',()=>{s.destroy();resolve('connected')});s.on('error',()=>resolve('blocked'));s.on('timeout',()=>{s.destroy();resolve('blocked')})});
    assert.equal(outcome,'blocked');
  }
  const browser=await chromium.launch({executablePath:'/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome',headless:true,args:['--no-sandbox',`--proxy-server=http://127.0.0.1:${port}`,'--proxy-bypass-list=<-loopback>','--disable-quic',`--ignore-certificate-errors-spki-list=${spki}`]});
  try {
    const context=await browser.newContext({serviceWorkers:'block'});
    await context.routeWebSocket('**/*', ws=>ws.close());
    const page=await context.newPage();
    await page.goto('https://www.douyin.com/');
    assert.equal(await page.locator('#state').textContent(),'login');
    await page.click('#challenge');
    await page.waitForFunction(()=>document.querySelector('#state').textContent==='challenge');
    assert.equal((await context.cookies()).some(c=>c.name==='sessionid'),false);
    await page.click('#complete');
    await page.waitForFunction(()=>document.querySelector('#state').textContent==='complete');
    assert.equal((await context.cookies()).some(c=>c.name==='sessionid'&&c.value==='synthetic'),true);
    const r=await page.evaluate(async p=>{
      const attempt=async u=>{try {const r=await fetch(u);return 'status:'+r.status}catch{return 'failed'}};
      const direct=await attempt(`http://127.0.0.1:${p}/`);
      const redirect=await attempt('/redirect');
      const foreign=await attempt('https://attacker.invalid/');
      const directPublic=await attempt('https://8.8.8.8/');
      const ws=await new Promise(resolve=>{const s=new WebSocket('wss://www.douyin.com/socket');s.onerror=()=>resolve('failed');s.onopen=()=>resolve('open');setTimeout(()=>resolve('timeout'),1500)});
      return {direct,redirect,foreign,directPublic,ws};
    },privatePort);
    assert.equal(r.direct,'failed'); assert.equal(r.redirect,'failed'); assert.equal(r.foreign,'failed'); assert.equal(r.directPublic,'failed'); assert.notEqual(r.ws,'open');
    const separate=await browser.newContext(); assert.deepEqual(await separate.cookies(),[]); await separate.close();
    console.log('CHILD_OK');
  } finally {await browser.close()}
} else {
 test('fixture-only host proxy and Chromium network namespace', {skip:process.env.DOUYIN_TEST_NETNS!=='1', timeout:60000}, async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'douyin-netns-proxy-'));let fixture,privateServer,proxy;const sockets=new Set(), events=[],counts={denied:0,dnsDenied:0,tunnels:0};let privateHits=0;
  try {
   const key=path.join(dir,'key'),cert=path.join(dir,'cert'),sock=path.join(dir,'proxy.sock');
   execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=www.douyin.com','-addext','subjectAltName=DNS:www.douyin.com'],{stdio:'ignore'});
   const spki=execFileSync('sh',['-c',`openssl x509 -in "$1" -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | openssl base64 -A`,'sh',cert],{encoding:'utf8'});
   privateServer=http.createServer((q,r)=>{privateHits++;r.end('private')});await new Promise(r=>privateServer.listen(0,'127.0.0.1',r));
   fixture=https.createServer({key:fs.readFileSync(key),cert:fs.readFileSync(cert)},(q,r)=>{
    events.push([q.method,q.url,q.headers.cookie||'']);
    if(q.url==='/'){r.writeHead(200,{'content-type':'text/html; charset=utf-8','set-cookie':'scope=alpha; Path=/mock; Secure; HttpOnly'});r.end(`<div id="state">login</div><button id="challenge">challenge</button><button id="complete">complete</button><script>challenge.onclick=async()=>{await fetch('/mock/challenge',{method:'POST',body:'synthetic'});state.textContent='challenge'};complete.onclick=async()=>{await fetch('/mock/complete',{method:'POST',body:'synthetic'});state.textContent='complete'}</script>`)}
    else if(q.url==='/mock/challenge'){r.end('challenge')}
    else if(q.url==='/mock/complete'){r.setHeader('set-cookie','sessionid=synthetic; Secure; HttpOnly; Path=/');r.end('ok')}
    else if(q.url==='/redirect'){r.writeHead(302,{location:`http://127.0.0.1:${privateServer.address().port}/`});r.end()}
    else {r.writeHead(404);r.end()}
   });fixture.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s))});await new Promise(r=>fixture.listen(0,'127.0.0.1',r));
   let mixed=false;proxy=await createFixtureProxy({socketPath:sock,fixturePort:fixture.address().port,counts,lookup:async()=>mixed?[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]:[{address:'8.8.8.8',family:4}]});
   // Mixed DNS is denied before any upstream connection.
   mixed=true; const net=await import('node:net');await new Promise((resolve,reject)=>{const s=net.connect(sock,()=>s.write('CONNECT www.douyin.com:443 HTTP/1.1\r\n\r\n'));let data='';s.on('data',d=>data+=d);s.on('end',()=>{try{assert.match(data,/403/);resolve()}catch(e){reject(e)}});s.on('error',reject)});mixed=false;assert.equal(counts.dnsDenied,1);assert.equal(counts.tunnels,0);
   // Only an AF_UNIX socket crosses the netns boundary. The bridge has no TCP
   // upstream except that socket; the child netns contains loopback only.
   const cmd='ip link set lo up || exit 1; socat TCP-LISTEN:32187,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:"$1" </dev/null >/dev/null 2>&1 & bridge=$!; sleep 0.3; node "$2" child 32187 "$3" "$4"; rc=$?; kill $bridge 2>/dev/null; exit $rc';
   const result=await new Promise((resolve,reject)=>{const p=spawn('unshare',['--net','sh','-c',cmd,'sh',sock,own,spki,String(privateServer.address().port)],{env:{...process.env,DOUYIN_TEST_NETNS:'0'}});let out='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>out+=d);p.on('error',reject);p.on('close',code=>resolve({code,out}))});
   assert.equal(result.code,0,result.out);assert.match(result.out,/CHILD_OK/);assert.equal(privateHits,0);assert.ok(counts.tunnels>0);assert.ok(counts.denied>0);assert.deepEqual(events.filter(x=>x[1].startsWith('/mock/')).map(x=>x.slice(0,2)),[['POST','/mock/challenge'],['POST','/mock/complete']]);assert.ok(events.filter(x=>x[1].startsWith('/mock/')).every(x=>x[2].includes('scope=alpha')));assert.equal(events.filter(x=>x[1]==='/socket').length,0);
  } finally {for(const s of sockets)s.destroy();if(proxy)await new Promise(r=>proxy.close(r));if(fixture)await new Promise(r=>fixture.close(r));if(privateServer)await new Promise(r=>privateServer.close(r));fs.rmSync(dir,{recursive:true,force:true})}
 });
}
