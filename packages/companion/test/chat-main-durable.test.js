import test from 'node:test';
import assert from 'node:assert/strict';
import {startMainDurableChat,createMainDurableTransport} from '../src/chat-main-durable.js';
import fs from 'node:fs';
import path from 'node:path';

test('main durable runtime is disabled without explicit config', () => {
  assert.equal(startMainDurableChat({}),null);
  assert.equal(startMainDurableChat({config:{enabled:false}}),null);
});
test('main durable runtime refuses opt-in without local card trust', () => {
  assert.throws(()=>startMainDurableChat({config:{enabled:true}}),/trust/);
});
test('main transport requires explicit pinned ingress and sender scope',()=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'durable-transport-'));
 try {
  const caPath=path.join(dir,'fixture-ca');fs.writeFileSync(caPath,'fixture certificate');
  const config={enabled:true,ownerId:'123',transport:{caPath,certificateSha256:'a'.repeat(64),senderUrl:'https://127.0.0.1:1234/'}};
  assert.equal(createMainDurableTransport({config:{enabled:false}}),null);
  assert.throws(()=>createMainDurableTransport({config,onebot:{wsUrl:'ws://127.0.0.1:1234'},ownerIds:['123']}),/wss/i);
  const result=createMainDurableTransport({config,onebot:{wsUrl:'wss://127.0.0.1:1234'},ownerIds:['123']});
  assert.equal(result.ingressAuthentication.ownerId,'123');assert.equal(result.ingressAuthentication.ca.toString(),'fixture certificate');
  assert.throws(()=>createMainDurableTransport({config,onebot:{wsUrl:'wss://127.0.0.1:1234'},ownerIds:['999']}),/owner/i);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
