import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { createHandoffBridge } from '../src/douyin-handoff-bridge.js';
const {WebSocket}=createRequire(import.meta.url)('ws');
test('explicit cancel still reaches in-flight verification after disconnect',async()=>{
 let cancelled=0, started=0;
 let release;const pending=new Promise(r=>release=r);
 const service={startHeadedDouyin:()=>({state:'starting'}),headedDouyinDisplay:()=>null,disconnectHeadedDouyin:()=>{started++;return pending},cancelHeadedDouyin:async()=>{cancelled++}};
 const bridge=createHandoffBridge({enabled:true,service,accessToken:'synthetic-only-123456789012345678901234',readyMs:1000,ttlMs:3000});
 const server=http.createServer((q,s)=>{if(!bridge.handle(q,s)){s.statusCode=404;s.end()}});server.on('upgrade',(q,s,h)=>bridge.upgrade(q,s,h));
 await new Promise(r=>server.listen(0,'127.0.0.1',r)); const base=`http://127.0.0.1:${server.address().port}`;
 const authorization='Basic '+Buffer.from('room:synthetic-only-123456789012345678901234').toString('base64');const headers={authorization,origin:base};
 try {
 const token=(await (await fetch(base+'/handoff/start',{method:'POST',headers})).json()).token;
 const ws=new WebSocket(base.replace('http','ws')+'/handoff/relay',{headers}); await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j)});ws.send(token);
 await new Promise(r=>setTimeout(r,50));ws.close();await new Promise(r=>ws.once('close',r));
 for(let i=0;i<30&&!started;i++)await new Promise(r=>setTimeout(r,10));assert.equal(started,1);
 assert.equal((await fetch(base+'/handoff/cancel',{method:'POST',headers})).status,204);
 assert.equal(cancelled,1,'cancel must invalidate an in-flight verification');
 } finally {release();await bridge.close();await new Promise(r=>server.close(r));}
});
