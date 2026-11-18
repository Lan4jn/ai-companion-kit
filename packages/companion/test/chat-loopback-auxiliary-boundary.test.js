import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {WebSocketServer} from 'ws';
import {OneBot} from '../src/transport-onebot.js';

const listen = s => new Promise(r=>s.listen(0,'127.0.0.1',r));
const close = s => new Promise(r=>s.close(r));
const auth={enabled:true,trustLoopbackOneBot:true,ownerId:'123'};
test('loopback mode rejects an untrusted auxiliary HTTP endpoint',()=>{
  assert.throws(()=>new OneBot({wsUrl:'ws://127.0.0.1:1/',httpUrl:'http://example.invalid/',accessToken:'synthetic-secret',ingressAuthentication:auth}),/loopback/i);
  for (const httpUrl of ['http://localhost:80','http://127.1:80','http://user:pass@127.0.0.1:80','http://127.0.0.1:80/path','http://127.0.0.1:80/?token=x']) {
    assert.throws(()=>new OneBot({wsUrl:'ws://127.0.0.1:1/',httpUrl,ingressAuthentication:auth}),/loopback/i);
  }
});
test('loopback auxiliary API never follows redirects with credentials',async()=>{
  let leaked=0, bot;
  const target=http.createServer((req,res)=>{leaked++;res.end('{}');});
  const source=http.createServer((req,res)=>{res.writeHead(307,{location:`http://127.0.0.1:${target.address().port}/stolen`});res.end();});
  const wss=new WebSocketServer({server:source});
  try {
    await listen(target);await listen(source);
    const base=`http://127.0.0.1:${source.address().port}`;
    bot=new OneBot({wsUrl:base.replace('http:','ws:'),httpUrl:base,accessToken:'synthetic-secret',ingressAuthentication:auth});
    const result=await bot.api('get_login_info');
    assert.equal(result.ok,false);assert.equal(leaked,0);
  } finally {bot?.close();wss.clients.forEach(s=>s.terminate());await new Promise(r=>wss.close(r));await close(source);await close(target);}
});
