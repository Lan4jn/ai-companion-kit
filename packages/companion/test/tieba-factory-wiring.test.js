import test from 'node:test';
import assert from 'node:assert/strict';
import { setupProductionTieba } from '../src/index.js';

test('explicit candidate factory is injected once, shared and never constructed when disabled', async () => {
  let made=0, closed=0, received;
  const factory=()=>{made++;return {provider:{start:async()=>({state:'unknown'}),status:async()=>({state:'unknown'})}, source:{list:async()=>[],read:async()=>({})},close:async()=>{closed++;}}};
  const makeScheduler=o=>{received=o.reader;return {start(){},stop:async()=>{}}};
  assert.equal(setupProductionTieba({cfg:{tieba:{enabled:false,authenticatedCandidate:true}},candidateFactory:factory}),null);
  const h=setupProductionTieba({cfg:{tieba:{enabled:true,authenticatedCandidate:true}},candidateFactory:factory,makeScheduler});
  assert.equal(made,1); assert.ok(received); assert.equal(typeof h.loginProvider.start,'function');
  await h.stop(); assert.equal(closed,1);
});
