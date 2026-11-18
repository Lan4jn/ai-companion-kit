import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHandoffBridge} from '../src/douyin-handoff-bridge.js';

test('shutdown cancels pending verification and permanently rejects new handoffs', async()=>{
  let cancelled=0, started=0, release;
  const pending=new Promise(resolve=>{release=resolve});
  const service={startHeadedDouyin(){started++;return {state:'starting'}},headedDouyinDisplay(){return null},disconnectHeadedDouyin(){return pending},async cancelHeadedDouyin(){cancelled++;release();}};
  const token='synthetic-only-123456789012345678901234';
  const bridge=createHandoffBridge({enabled:true,service,accessToken:token,readyMs:1000,ttlMs:3000});
  const server=http.createServer((req,res)=>{if(!bridge.handle(req,res)){res.writeHead(404);res.end()}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const headers={authorization:'Basic '+Buffer.from('room:'+token).toString('base64'),origin:base};
  try {
    assert.equal((await fetch(base+'/handoff/start',{method:'POST',headers})).status,200);
    const closing=bridge.close();
    await new Promise(r=>setTimeout(r,20));
    assert.equal(cancelled,1,'shutdown must cancel rather than allow verification to promote credentials');
    await closing;
    assert.notEqual((await fetch(base+'/handoff/start',{method:'POST',headers})).status,200);
    assert.equal(started,1);
  } finally {release();await new Promise(r=>server.close(r));}
});
