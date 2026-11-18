import test from 'node:test';
import assert from 'node:assert/strict';
import {createDouyinHandoffServiceCandidate} from '../src/douyin-handoff-service-candidate.js';

test('candidate is disabled by default without allocating sandbox resources', async () => {
  let allocations=0;
  const candidate=createDouyinHandoffServiceCandidate({allocateBroker:()=>{allocations++;throw Error('unexpected');}});
  assert.deepEqual(candidate.service.startHeadedDouyin(),{state:'disabled'});
  assert.equal(candidate.bridge.handle({url:'/handoff/start'},{}),false);
  await candidate.close();
  assert.equal(allocations,0);
});

test('explicit candidate refuses unconfigured or official-mode sandbox', () => {
  assert.throws(()=>createDouyinHandoffServiceCandidate({enabled:true}),/synthetic|candidate/i);
});
