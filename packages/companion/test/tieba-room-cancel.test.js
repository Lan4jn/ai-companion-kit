import test from 'node:test';
import assert from 'node:assert/strict';
import { startVirtualRoomServer } from '../src/virtual-room.js';

test('owner can revoke tieba session through private POST; cross-origin requests are blocked', async t => {
  let active = true, cancelled = 0;
  const provider = { start: async()=>({state:'online'}), status: async()=>({state:active?'online':'unknown'}), cancel: async()=>{cancelled++; active=false; return {state:'unknown'};} };
  const room = startVirtualRoomServer({port:0,host:'127.0.0.1',tiebaLoginProvider:provider});
  t.after(()=>room.stop());
  const {port}=await room.ready, base=`http://127.0.0.1:${port}`;
  const page=await (await fetch(base+'/login')).text();
  assert.match(page,/tieba-cancel/);
  assert.equal((await fetch(base+'/api/account/tieba/cancel',{method:'GET'})).status,404);
  assert.equal((await fetch(base+'/api/account/tieba/cancel',{method:'POST',headers:{origin:'http://evil.invalid'}})).status,403);
  assert.equal(cancelled,0);
  const response=await fetch(base+'/api/account/tieba/cancel',{method:'POST',headers:{origin:base}});
  assert.equal(response.status,200); assert.deepEqual(await response.json(),{state:'unknown'});
  assert.equal(cancelled,1);
  assert.deepEqual(await (await fetch(base+'/api/account/tieba/status')).json(),{state:'unknown'});
});
