import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import {execFileSync} from 'node:child_process';
import {createHeadedDisplay} from '../src/douyin-headed-display.js';
import {startDaemon} from '../src/douyin-qr-daemon.js';

async function until(f, ms=15000) { const end=Date.now()+ms; while(Date.now()<end){if(await f())return; await new Promise(r=>setTimeout(r,100));} throw Error('timed out'); }
function rfb(socket,token) {
 const s=net.createConnection(socket); let buf=Buffer.alloc(0), pending=[];
 s.on('data',d=>{buf=Buffer.concat([buf,d]); pump();});
 function pump(){while(pending.length && buf.length>=pending[0].n){const p=pending.shift(); const b=buf.subarray(0,p.n);buf=buf.subarray(p.n);p.resolve(b);}}
 s.on('error',()=>{for(const p of pending)p.reject(Error('RFB closed'));pending=[];});
 const read=n=>new Promise((resolve,reject)=>{pending.push({n,resolve,reject});pump()});
 s.on('connect',()=>s.write(token+'\n'));
 return {s,read};
}

test('synthetic headed daemon keeps challenge and candidate in the same browser', {timeout:45000},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dy-headed-e2e-'));
 const old=path.join(root,'old-credentials');fs.writeFileSync(old,'unchanged');
 const server=http.createServer((req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');res.end(`<!doctype html><style>html,body{margin:0;background:red;width:100%;height:100%}#login-full-panel{width:100%;height:100%}</style><div id="login-full-panel">扫码登录</div><script>let stage=0;onpointerup=e=>{if(!e.isTrusted)return;if(stage++===0){document.querySelector('#login-full-panel').innerText='安全验证';document.body.style.background='blue'}else{document.cookie='sessionid=synthetic-test-session; path=/';document.querySelector('#login-full-panel').remove();document.body.style.background='lime'}}</script>`)});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 let display, daemon; const controller=new AbortController();
 try{
  display=await createHeadedDisplay({root,ttlMs:35000});
  daemon=startDaemon({sessionDir:root,headed:true,displayEnv:display.env,url:`http://127.0.0.1:${server.address().port}/`,delays:{initial:100,qr:100,poll:100},signal:controller.signal});
  await until(()=>{try{return JSON.parse(fs.readFileSync(path.join(root,'status.json'))).status==='waiting_modal'}catch{return false}});
  const {s,read}=rfb(display.socket,display.token);
  assert.match((await read(12)).toString(),/^RFB/);s.write('RFB 003.008\n');
  const count=(await read(1))[0];const types=await read(count);assert.ok(types.includes(1));s.write(Buffer.from([1]));assert.equal((await read(4)).readUInt32BE(),0);
  s.write(Buffer.from([1])); const init=await read(24);await read(init.readUInt32BE(20));
  const click=async()=>{s.write(Buffer.from([5,0,1,244,1,144]));await new Promise(r=>setTimeout(r,100));s.write(Buffer.from([5,1,1,244,1,144]));await new Promise(r=>setTimeout(r,150));s.write(Buffer.from([5,0,1,244,1,144]));};
  s.write(Buffer.from([3,0,0,0,0,0,0,1,0,1]));
  await new Promise(r=>setTimeout(r,1500)); await click(); await until(()=>{try{return JSON.parse(fs.readFileSync(path.join(root,'status.json'))).status==='need_sms'}catch{return false}});
  assert.equal(fs.existsSync(path.join(root,'cookies.json')),false); assert.equal(fs.existsSync(path.join(root,'qr.png')),false);
  await click(); await daemon;
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'status.json'))).status,'success');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'cookies.json'))).some(c=>c.name==='sessionid'),true);
  assert.equal(fs.readFileSync(old,'utf8'),'unchanged');
  s.destroy(); await display.closed;
 } finally {controller.abort();if(display) await display.close();if(daemon) await daemon.catch(()=>{});await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});}
});
