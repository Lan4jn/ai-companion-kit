import test from 'node:test';
import assert from 'node:assert/strict';
import { startVirtualRoomServer } from '../src/virtual-room.js';

test('candidate page names owner handoff and refreshes verified status without credential form', async t=>{
 const room=startVirtualRoomServer({host:'127.0.0.1',port:0,tiebaLoginProvider:{start:async()=>({state:'unknown'}),status:async()=>({state:'unknown'})}});
 t.after(()=>room.stop()); const {port}=await room.ready;
 const html=await (await fetch(`http://127.0.0.1:${port}/login`)).text();
 assert.match(html,/主人接管/); assert.match(html,/statusTieba/); assert.match(html,/api\/account\/tieba\/status/);
 assert.doesNotMatch(html,/<input[^>]+(?:password|验证码|cookie)/i);
});
