// Offline-only adapter connecting the real handoff bridge to the isolated fixture worker.
// This is not a production launcher or an authorization to use real accounts.
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import {createCandidateBroker} from '../src/douyin-request-broker-candidate.js';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright-core';
import {createDouyinHandoffServiceCandidate} from '../src/douyin-handoff-service-candidate.js';
import assert from 'node:assert/strict';

if (!process.env.NODE_TEST_CONTEXT || process.getuid() !== 0) throw Error('fixture only');
const [work, mode] = process.argv.slice(2);
let child, exited, stopping, bridge, server, browser, broker, fixture;
let hits=[], inputStates=[];
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=25000) {const end=Date.now()+ms;while(Date.now()<end){try {const v=fn();if(v)return v;}catch{}await delay(100);}throw Error('fixture timeout');}
const status=()=>JSON.parse(fs.readFileSync(sessionDir()+'/status.json','utf8')).status;
// Inject only at the real service's existing fork seam. This launcher is
// synthetic-only; it does not weaken the real daemon's fail-closed gate.
const sessions=work+'/sessions'; fs.mkdirSync(sessions,{mode:0o700});
const dataDir=work+'/data';
const secret='synthetic-only-123456789012345678901234';
const candidate=createDouyinHandoffServiceCandidate({enabled:true,accessToken:secret,
 loginOptions:{headedSessionRoot:sessions,dataDir,verifyDouyin:async()=>({state:'online'})},
 bridgeOptions:{ttlMs:mode==='timeout'?20000:60000,readyMs:mode==='timeout'?15000:20000},
 launcher:{
  prepareSession(dir){fs.chownSync(dir,65534,65534);},
  createBrokerSocket(socket){return broker=createCandidateBroker({inheritedSocket:socket,fixturePolicy:(m,u)=>(m==='GET'&&u==='https://www.douyin.com/')||(m==='POST'&&['https://www.douyin.com/challenge','https://www.douyin.com/complete'].includes(u)),transportOptions:{lookup:async()=>[{address:'8.8.8.8',family:4}],port:fixture.address().port,ca:fs.readFileSync(work+'/cert')}});},
  environment:env=>({...env,HOME:'/tmp',TMPDIR:'/tmp'}),
  command:'/usr/bin/python3',args:dir=>[work+'/app/scripts/isolated_session_supervisor.py','--synthetic-fixture',dir,work+'/chrome/chrome'],
  onChild(c){child=c;exited=new Promise(resolve=>{c.once('error',e=>resolve({error:e}));c.once('exit',(code,signal)=>resolve({code,signal}));});}
 }});
const {service}=candidate; bridge=candidate.bridge;
function stop(){if(!stopping) stopping=service.cancelHeadedDouyin();return stopping;}
const sessionDir=()=>{const names=fs.readdirSync(sessions).filter(n=>n.startsWith('session-'));return names.length ? sessions+'/'+names[0] : null;};
try {
 fixture=https.createServer({key:fs.readFileSync(work+'/key'),cert:fs.readFileSync(work+'/cert')},(req,res)=>{
  hits.push(req.url);
  if(req.url==='/'){const refresh=mode==='refresh'; const initial=hits.filter(p=>p==='/').length===1;res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(`<style>html,body,#login-full-panel{margin:0;width:100%;height:100%}input{position:absolute;left:350px;top:300px;width:300px;height:45px}</style><div id="login-full-panel">扫码登录</div><script>let n=0;const expire=${refresh && initial};onpointerup=async e=>{if(!e.isTrusted||e.target.tagName==='INPUT')return;if(expire){document.querySelector('#login-full-panel').textContent='二维码已过期';return}if(n++===0){await fetch('/challenge',{method:'POST'});document.querySelector('#login-full-panel').innerHTML='安全验证<input id="synthetic-input">';document.querySelector('#synthetic-input').onkeydown=e=>{if(e.key==='Enter')fetch('/challenge',{method:'POST',body:JSON.stringify(Array(10).fill(false).concat(e.target.value==='abccxy'))})};document.querySelector('#synthetic-input').oninput=e=>fetch('/challenge',{method:'POST',body:JSON.stringify(['abc中文','abc中','112233','11223','1122399','1234','123','abc','ab','abcc'].map(v=>e.target.value===v))})}else{if(${mode==='input'} && document.querySelector('#synthetic-input').value!=='abc中文')return;await fetch('/complete',{method:'POST'});document.querySelector('#login-full-panel').remove()}}</script>`);}
  else if(req.url==='/challenge'){let body='';req.on('data',b=>body+=b);req.on('end',()=>{if(body)inputStates.push(JSON.parse(body));res.end('challenge');});}
  else if(req.url==='/complete'){res.writeHead(200,{'set-cookie':'sessionid=fixture; Path=/; Secure; HttpOnly'});res.end('ok');}
  else {res.writeHead(404);res.end();}
 });
 await new Promise(r=>fixture.listen(0,'8.8.8.8',r));
 server=http.createServer((req,res)=>{if(!bridge.handle(req,res)){res.writeHead(404);res.end();}});
 server.on('upgrade',(req,socket,head)=>{if(!bridge.upgrade(req,socket,head))socket.destroy();});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({executablePath:'/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome',headless:true,args:['--no-sandbox','--disable-background-networking']});
 const context=await browser.newContext({httpCredentials:{username:'room',password:secret},viewport:{width:1024,height:850}});
 const page=await context.newPage();await page.goto(base+'/handoff');await page.locator('#start').click();
 await page.waitForFunction(()=>document.querySelector('#status').textContent==='ready',null,{timeout:25000});
 const observed=[];
 await until(()=>{try{const s=status();if(observed.at(-1)!==s)observed.push(s);return s==='waiting_modal';}catch{return false;}}).catch(e=>{throw Error(`${e.message}; statuses=${JSON.stringify(observed)}; child=${JSON.stringify(child && {exitCode:child.exitCode,signalCode:child.signalCode})}; requests=${JSON.stringify(hits)}`);});
 const info=service.headedDouyinDisplay();assert.ok(info?.socket);
 const dir=sessionDir();
 const fixtureUid=fs.statSync(dir).uid;
 const descendants=pid=>{
  const seen=new Set(), todo=[pid];
  while(todo.length){const p=todo.pop();try{for(const tid of fs.readdirSync(`/proc/${p}/task`)) for(const c of fs.readFileSync(`/proc/${p}/task/${tid}/children`,'utf8').trim().split(/\s+/).filter(Boolean).map(Number)) if(!seen.has(c)){seen.add(c);todo.push(c);}}catch(e){if(e.code!=='ENOENT' && e.code!=='ESRCH')throw e;}}
  return [...seen];
 };
 const pids=descendants(child.pid);assert.ok(pids.length>=5, 'headed browser process tree expected');
 await delay(2000); // Allow the initial synthetic page frame to reach the viewer.
 if(mode==='login'||mode==='refresh'||mode==='input'||mode==='digits'){
  const originalPid=child.pid;
  if(mode==='refresh') {
   await page.locator('canvas').click({position:{x:500,y:400},delay:200});
   await until(()=>hits.filter(p=>p==='/').length===2,20000);
   await until(()=>status()==='waiting_modal',20000);
   assert.equal(child.pid,originalPid);
  }
  await page.locator('canvas').click({position:{x:500,y:400},delay:200});
  await until(()=>status()==='need_sms');assert.equal(fs.existsSync(dir+'/cookies.json'),false);
  if(mode==='digits') {
   await delay(1500);
   const box=await page.locator('canvas').boundingBox();
   await page.locator('canvas').click({position:{x:500*box.width/1024,y:400*box.height/768}});
   const keyboard=page.locator('#keyboard-input'); await keyboard.focus();
   await keyboard.evaluate(el=>{for(const ch of '112233')el.dispatchEvent(new InputEvent('input',{bubbles:true,data:ch,inputType:'insertText'}));});
   await page.keyboard.press('Backspace');
   // Hiding the mobile keyboard must not cancel queued events.
   await keyboard.blur();
   await delay(1800); assert.ok(inputStates.at(-1)?.[3], 'queued digit and physical backspace order mismatch');
   await keyboard.focus();
   await keyboard.evaluate(el=>{for(const ch of '99')el.dispatchEvent(new InputEvent('input',{bubbles:true,data:ch,inputType:'insertText'}));});
   await delay(900); assert.ok(inputStates.at(-1)?.[4], 'repeated digit mismatch');
   await keyboard.evaluate(el=>{for(let i=0;i<7;i++)el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward'}));for(const ch of 'abc')el.dispatchEvent(new InputEvent('input',{bubbles:true,data:ch,inputType:'insertText'}));});
   await delay(1500);assert.ok(inputStates.at(-1)?.[7], 'mobile deletion and ASCII mismatch');
   await keyboard.evaluate(el=>{el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward'}));for(const ch of 'cc')el.dispatchEvent(new InputEvent('input',{bubbles:true,data:ch,inputType:'insertText'}));});
   await delay(900);assert.ok(inputStates.at(-1)?.[9], 'mobile deletion and repeated ASCII mismatch');
  // Enter must follow, not overtake, the two queued characters in the actual RFB path.
   const beforeEnter=inputStates.length;
   await keyboard.evaluate(el=>{for(const ch of 'xy')el.dispatchEvent(new InputEvent('input',{bubbles:true,data:ch,inputType:'insertText'}));});
   await page.keyboard.press('Enter');
   await delay(1500);assert.ok(inputStates.length>beforeEnter && inputStates.at(-1)?.[10], 'Enter overtook queued text');
  }
  if(mode==='input') {
   // Canvas scales the 1024x768 remote framebuffer to the page width.
   const box=await page.locator('canvas').boundingBox();
   await page.locator('canvas').click({position:{x:500*box.width/1024,y:400*box.height/768}});
   const keyboard=page.locator('#keyboard-input');await keyboard.focus();
   await page.keyboard.type('abc');
   await keyboard.evaluate(el=>{el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中文'}));el.dispatchEvent(new InputEvent('input',{bubbles:true,data:'中文',inputType:'insertFromComposition'}));});
   await delay(1500);assert.ok(inputStates.at(-1)?.[0], 'synthetic input mismatch');
   // Mobile keyboards may emit deletion as an input event without keydown.
   await keyboard.evaluate(el=>el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward'})));
   await delay(500);assert.ok(inputStates.at(-1)?.[1], 'mobile deletion should reach the remote input');
   await keyboard.evaluate(el=>el.dispatchEvent(new InputEvent('input',{bubbles:true,data:'文',inputType:'insertText'})));
   await delay(500);assert.ok(inputStates.at(-1)?.[0]);
  }
  await delay(12000); // A person may take longer than the broker idle interval.
  // Complete outside the synthetic input: the login and refresh scenarios also
  // render that field, so clicking its center merely focuses it.
  await page.locator('canvas').click({position:{x:100,y:400},delay:200});
  await until(()=>status()==='success').catch(e=>{throw Error(`${e.message}; status=${status()}; requests=${JSON.stringify(hits)}`);});
  assert.ok(JSON.parse(fs.readFileSync(dir+'/cookies.json','utf8')).some(c=>c.name==='sessionid'&&c.value==='fixture'));
  assert.equal(child.pid,originalPid);
  assert.deepEqual(hits.filter(path=>['/','/challenge','/complete'].includes(path)),mode==='refresh'?['/','/','/challenge','/complete']:['input','digits'].includes(mode)?['/','/challenge',...inputStates.map(()=>'/challenge'),'/complete']:['/','/challenge','/complete']);
  await context.close();
 } else if(mode==='crash') {
  // The outer service must clean up on exit without an explicit cancel, even
  // if the killed supervisor had already published a synthetic candidate.
  const sentinel=sessions+'/unrelated-active';fs.mkdirSync(sentinel);fs.writeFileSync(sentinel+'/keep','active');
  fs.writeFileSync(dir+'/status.json',JSON.stringify({status:'success'}));
  child.kill('SIGKILL');
  await exited;
  await until(()=>pids.every(p=>{try{return fs.readFileSync(`/proc/${p}/stat`,'utf8').split(') ')[1][0]==='Z';}catch(e){if(e.code==='ENOENT')return true;throw e;}}),15000);
 } else {
  await page.locator('canvas').click({position:{x:500,y:400},delay:200});
  await until(()=>status()==='need_sms');
  if(mode==='disconnect')await context.close();
  else if(mode==='cancel')await page.locator('#cancel').click();
  else if(mode==='timeout')await page.waitForFunction(()=>document.querySelector('#status').textContent==='已断开，可重新开始',null,{timeout:25000});
  else throw Error('unknown scenario');
  assert.equal(fs.existsSync(dir+'/cookies.json'),false);
 }
 await until(()=>!fs.existsSync(dir),15000);
 if(mode==='crash') assert.equal(fs.readFileSync(sessions+'/unrelated-active/keep','utf8'),'active');
 await stop();
 await until(()=>!fs.existsSync(info.socket),10000);
 await until(()=>pids.every(p=>{try{return fs.readFileSync(`/proc/${p}/stat`,'utf8').split(') ')[1][0]==='Z';}catch(e){if(e.code==='ENOENT'||e.code==='ESRCH')return true;throw e;}}),15000);
 await until(()=>fs.readdirSync('/proc').filter(n=>/^\d+$/.test(n)).every(n=>{try{const stat=fs.readFileSync(`/proc/${n}/stat`,'utf8').split(') ')[1];return fs.statSync(`/proc/${n}`).uid!==fixtureUid || stat[0]==='Z';}catch(e){if(e.code==='ENOENT'||e.code==='ESRCH')return true;throw e;}}),15000);
 const result=await exited;assert.ok(!result.error, String(result.error));
 if(mode==='crash') assert.equal(result.signal,'SIGKILL');
 else assert.equal(result.code,0,'worker should shut down cleanly');
 assert.equal(fs.existsSync(dir),false);
 if(['login','refresh','input','digits'].includes(mode)) assert.equal(JSON.parse(fs.readFileSync(dataDir+'/douyin-cookies.json','utf8'))[0].value,'fixture');
 else assert.equal(fs.existsSync(dataDir+'/douyin-cookies.json'),false);
 // A process group probe catches surviving worker, display and Chromium children.
 await until(()=>{try{process.kill(-child.pid,0);return false;}catch(e){return e.code==='ESRCH';}},10000);
 console.log(`PASS ${mode}: real viewer -> isolated headed fixture -> challenge; worker/display process group and socket cleaned`);
} finally {await candidate.close();await stop();await browser?.close();await broker?.close();if(server)await new Promise(r=>server.close(r));if(fixture)await new Promise(r=>fixture.close(r));}
