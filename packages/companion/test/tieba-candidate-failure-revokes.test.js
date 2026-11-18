import test from 'node:test';
import assert from 'node:assert/strict';
import { createTiebaLoginIntegration } from '../src/tieba-login-integration.js';
test('transport failure revokes candidate and reports unknown', async()=>{
 let closed=0;
 const c=createTiebaLoginIntegration({createSession:async()=>({context:{cookies:async()=>[]},close:async()=>{closed++}}),verifyIdentity:async()=>({state:'online'}),listSource:{list:async()=>{throw Error('network')}}});
 assert.deepEqual(await c.provider.start(),{state:'online'});
 await assert.rejects(c.source.list({forum:'肥鱼避难所吧'}));
 assert.deepEqual(await c.provider.status(),{state:'unknown'});assert.equal(closed,1);await c.close();
});
