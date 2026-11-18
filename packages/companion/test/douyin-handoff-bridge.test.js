import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHandoffBridge } from '../src/douyin-handoff-bridge.js';

test('bridge is disabled unless explicitly enabled and authenticated', async () => {
  assert.throws(() => createHandoffBridge({enabled:true}), /authentication/);
  const bridge=createHandoffBridge({enabled:false});
  const server=http.createServer((req,res)=>{if(!bridge.handle(req,res)){res.writeHead(404);res.end();}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try {assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/handoff`)).status,404);}
  finally {await new Promise(r=>server.close(r));}
});
