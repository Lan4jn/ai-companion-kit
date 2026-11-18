// Offline integration only. The host proxy has exactly one synthetic loopback
// upstream; this is not an implementation or compatibility claim for Douyin.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import {spawn, execFileSync} from 'node:child_process';
import {createHeadedDisplay} from '../src/douyin-headed-display.js';
import {startDaemon} from '../src/douyin-qr-daemon.js';
import {installMockPinnedRoute} from './fixtures/douyin-pinned-mock-route.js';

async function until(f){for(let i=0;i<150;i++){if(await f())return;await new Promise(r=>setTimeout(r,100));}throw Error('timed out');}
function rfb(socket,token){const s=net.createConnection(socket);let buf=Buffer.alloc(0),pending=[];function pump(){while(pending.length&&buf.length>=pending[0].n){const p=pending.shift(),b=buf.subarray(0,p.n);buf=buf.subarray(p.n);p.resolve(b);}}s.on('data',d=>{buf=Buffer.concat([buf,d]);pump();});s.on('error',()=>{for(const p of pending)p.reject(Error('RFB closed'));pending=[];});s.on('connect',()=>s.write(token+'\n'));return {s,read:n=>new Promise((resolve,reject)=>{pending.push({n,resolve,reject});pump();})};}
async function blocked(host,port){return await new Promise(resolve=>{const s=net.connect({host,port});s.setTimeout(1000);s.on('connect',()=>{s.destroy();resolve(false)});s.on('error',()=>resolve(true));s.on('timeout',()=>{s.destroy();resolve(true)});});}

if(process.argv[2]==='child'){
 const [root,cert,port,privatePort]=process.argv.slice(3);let display,daemon,socket,context,mixed=false,dnsCalls=0;
 const controller=new AbortController(),counts={denied:0,redirects:0,failed:0};
 try{
  assert.equal(await blocked('1.1.1.1',443),true);assert.equal(await blocked('127.0.0.1',Number(privatePort)),true);
  display=await createHeadedDisplay({root,ttlMs:50000});
  daemon=startDaemon({sessionDir:root,headed:true,displayEnv:display.env,url:'https://www.douyin.com/',delays:{initial:100,qr:100,poll:100},signal:controller.signal,installTestContext:async c=>{context=c;await installMockPinnedRoute(c,{lookup:async()=>{dnsCalls++;return mixed?[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]:[{address:'8.8.8.8',family:4}]},port:Number(port),ca:fs.readFileSync(cert)},counts);}});
  const status=()=>{try{return JSON.parse(fs.readFileSync(path.join(root,'status.json'))).status}catch{return ''}};
  await until(()=>status()==='waiting_modal');
  const r=rfb(display.socket,display.token);socket=r.s;assert.match((await r.read(12)).toString(),/^RFB/);socket.write('RFB 003.008\n');const n=(await r.read(1))[0];assert.ok((await r.read(n)).includes(1));socket.write(Buffer.from([1]));assert.equal((await r.read(4)).readUInt32BE(),0);socket.write(Buffer.from([1]));const init=await r.read(24);await r.read(init.readUInt32BE(20));
  const click=async()=>{socket.write(Buffer.from([5,0,1,244,1,144]));await new Promise(r=>setTimeout(r,100));socket.write(Buffer.from([5,1,1,244,1,144]));await new Promise(r=>setTimeout(r,150));socket.write(Buffer.from([5,0,1,244,1,144]));};
  await new Promise(r=>setTimeout(r,1000));await click();await until(()=>status()==='need_sms');assert.equal(fs.existsSync(path.join(root,'cookies.json')),false);
  assert.equal((await context.cookies('https://www.douyin.com/')).some(c=>c.name==='mock_scope'),false);assert.equal((await context.cookies('https://www.douyin.com/mock/challenge')).some(c=>c.name==='mock_scope'),true);
  const other=await context.browser().newContext();try{assert.deepEqual(await other.cookies(),[]);}finally{await other.close();}
  mixed=true;await context.pages()[0].evaluate(()=>fetch('/mock/challenge',{method:'POST'}).catch(()=>{}));mixed=false;assert.equal(counts.failed,1);
  const results=await context.pages()[0].evaluate(async privatePort=>{const attempt=async (u,o)=>{try{return (await fetch(u,o)).status}catch{return 'failed'}};const ws=await new Promise(resolve=>{const s=new WebSocket('wss://www.douyin.com/socket');s.onerror=()=>resolve('blocked');s.onopen=()=>resolve('open');setTimeout(()=>resolve('timeout'),1000)});return [await attempt('/not-allowed'),await attempt('/mock/complete',{method:'GET'}),await attempt('https://attacker.invalid/'),await attempt(`http://127.0.0.1:${privatePort}/`),ws]},privatePort);
  assert.deepEqual(results.slice(0,4),['failed','failed','failed','failed']);assert.notEqual(results[4],'open');
  await click();await daemon;assert.equal(status(),'success');const cookies=JSON.parse(fs.readFileSync(path.join(root,'cookies.json')));assert.ok(cookies.some(c=>c.name==='sessionid'&&c.httpOnly));
  assert.equal(counts.redirects,1);assert.ok(counts.denied>=4);assert.equal(dnsCalls,5);
  // Negative control: another process in this namespace can bypass Playwright's
  // method/path filter by talking TLS directly to the fixture relay. Therefore
  // this experiment is NOT a process-independent method/path boundary.
  const bypass=await new Promise((resolve,reject)=>{https.get({host:'8.8.8.8',port:Number(port),servername:'www.douyin.com',ca:fs.readFileSync(cert),path:'/not-allowed',agent:false},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));}).on('error',reject)});
  assert.equal(bypass,200);console.log('COMBINED_CHILD_OK; RAW_RELAY_BYPASS_CONFIRMED');
 }finally{controller.abort();socket?.destroy();await display?.close();if(daemon)await daemon.catch(()=>{});}
}else{
 test('headed daemon: system namespace plus exact pinned browser route, synthetic only',{skip:process.env.DOUYIN_TEST_NETNS!=='1',timeout:70000},async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'douyin-combined-'));let fixture,privateServer,proxy;let privateHits=0,tunnels=0;const events=[],sockets=new Set();
  try{
   const key=path.join(root,'key'),cert=path.join(root,'cert'),sock=path.join(root,'proxy.sock'),home=path.join(root,'home');fs.mkdirSync(home);
   execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=www.douyin.com','-addext','subjectAltName=DNS:www.douyin.com'],{stdio:'ignore'});
   privateServer=http.createServer((q,r)=>{privateHits++;r.end('private')});await new Promise(r=>privateServer.listen(0,'127.0.0.1',r));const privateUrl=`http://127.0.0.1:${privateServer.address().port}/`;
   fixture=https.createServer({key:fs.readFileSync(key),cert:fs.readFileSync(cert)},(q,r)=>{events.push([q.method,q.url,q.headers.cookie||'']);if(q.url==='/'){r.writeHead(200,{'content-type':'text/html; charset=utf-8','set-cookie':'mock_scope=alpha; Path=/mock; Secure; HttpOnly'});r.end(`<!doctype html><style>html,body,#login-full-panel{margin:0;width:100%;height:100%;background:red}</style><div id="login-full-panel">扫码登录</div><script>let stage=0;onpointerup=async e=>{if(!e.isTrusted)return;if(stage++===0){await fetch('/mock/challenge',{method:'POST',body:'synthetic'});document.querySelector('#login-full-panel').innerText='安全验证'}else{await fetch('/mock/redirect',{method:'POST'});try{await fetch('${privateUrl}')}catch{}await fetch('/mock/complete',{method:'POST',body:'synthetic'});document.querySelector('#login-full-panel').remove()}}</script>`);}else if(q.url==='/mock/redirect'){r.writeHead(302,{location:privateUrl});r.end();}else if(q.url==='/mock/complete'){r.writeHead(200,{'set-cookie':'sessionid=synthetic; Path=/; Secure; HttpOnly; SameSite=Lax'});r.end('ok');}else r.end('ok');});await new Promise(r=>fixture.listen(0,'127.0.0.1',r));
   // Raw TLS relay fixed to this fixture; never resolves names or reaches the Internet.
   proxy=net.createServer(client=>{const upstream=net.connect(fixture.address().port,'127.0.0.1');tunnels++;sockets.add(client);sockets.add(upstream);client.on('error',()=>{});upstream.on('error',()=>client.destroy());client.on('close',()=>{sockets.delete(client);upstream.destroy()});upstream.on('close',()=>{sockets.delete(upstream);client.destroy()});client.pipe(upstream);upstream.pipe(client);});await new Promise(r=>proxy.listen(sock,r));
   const cmd='ip link set lo up && ip addr add 8.8.8.8/32 dev lo || exit 1; socat TCP-LISTEN:32188,bind=8.8.8.8,reuseaddr,fork UNIX-CONNECT:"$1" </dev/null >/dev/null 2>&1 & bridge=$!; sleep 0.3; node "$2" child "$3" "$4" 32188 "$5"; rc=$?; kill $bridge 2>/dev/null; exit $rc';
   const out=await new Promise((resolve,reject)=>{const p=spawn('unshare',['--net','sh','-c',cmd,'sh',sock,new URL(import.meta.url).pathname,root,cert,String(privateServer.address().port)],{env:{...process.env,HOME:home,DOUYIN_TEST_NETNS:'0'}});let text='';p.stdout.on('data',d=>text+=d);p.stderr.on('data',d=>text+=d);p.on('error',reject);p.on('close',code=>resolve({code,text}));});
   assert.equal(out.code,0,out.text);assert.match(out.text,/RAW_RELAY_BYPASS_CONFIRMED/);assert.equal(privateHits,0);assert.equal(tunnels,5);assert.deepEqual(events.map(e=>e.slice(0,2)),[['GET','/'],['POST','/mock/challenge'],['POST','/mock/redirect'],['POST','/mock/complete'],['GET','/not-allowed']]);assert.ok(!events[0][2]);assert.ok(events.slice(1,4).every(e=>e[2].includes('mock_scope=alpha')));assert.equal(events[4][2],'');
  }finally{for(const s of sockets)s.destroy();if(proxy)await new Promise(r=>proxy.close(r));if(fixture)await new Promise(r=>fixture.close(r));if(privateServer)await new Promise(r=>privateServer.close(r));fs.rmSync(root,{recursive:true,force:true});}
 });
}
