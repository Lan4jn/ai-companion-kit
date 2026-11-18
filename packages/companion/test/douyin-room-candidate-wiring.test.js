import test from 'node:test';
import assert from 'node:assert/strict';
import {startVirtualRoomServer} from '../src/virtual-room.js';

test('configured handoff rejects missing sandbox instead of silently falling back', () => {
  assert.throws(() => startVirtualRoomServer({port:0, douyinHandoff:true, accessToken:'x'.repeat(40)}), /candidate|sandbox/i);
});

test('room forwards injected synthetic launcher and closes its real bridge', async () => {
  const room=startVirtualRoomServer({port:0, accessToken:'x'.repeat(40), douyinHandoff:true,
    douyinHandoffCandidate:{launcher:{brokerFd:99,createBroker:()=>({close(){}}),command:'/bin/false',args:()=>[]}}});
  try {
    const addr=await room.ready;
    const response=await fetch(`http://127.0.0.1:${addr.port}/handoff`,{headers:{authorization:'Basic '+Buffer.from('room:'+ 'x'.repeat(40)).toString('base64')}});
    assert.equal(response.status,200);
  } finally {await room.stop();}
});
