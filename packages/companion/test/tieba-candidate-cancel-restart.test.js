import test from 'node:test';
import assert from 'node:assert/strict';
import { createTiebaLoginIntegration } from '../src/tieba-login-integration.js';

test('cancel revokes a pending owner session and permits a fresh start', async () => {
  let release, count=0, closed=0;
  const gate = new Promise(r => { release=r; });
  const c = createTiebaLoginIntegration({
    createSession: async () => { if (++count===1) await gate; return {context:{cookies:async()=>[]},close:async()=>{closed++}}; },
    verifyIdentity:async()=>({state:'online'}), listSource:{list:async()=>[]},
    createTransport:async()=>({fetchBody:async()=>{},close:async()=>{}}),
  });
  const first=c.provider.start();
  assert.equal(typeof c.provider.cancel,'function');
  const cancelling=c.provider.cancel(); release();
  assert.deepEqual(await first,{state:'unknown'}); await cancelling;
  assert.equal(closed,1); assert.equal((await c.provider.status()).state,'unknown');
  assert.equal((await c.provider.start()).state,'online');
  await c.provider.cancel(); assert.equal(closed,2);
  assert.equal((await c.provider.status()).state,'unknown');
  await c.close();
});
