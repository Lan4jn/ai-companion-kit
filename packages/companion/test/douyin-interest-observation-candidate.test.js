import test from 'node:test';
import assert from 'node:assert/strict';
import { observeDouyinInterestCandidate } from '../src/douyin-interest-observation-candidate.js';

test('caller supplied playback or consent cannot enable storage or invoke the model without a captured observation', async () => {
  let decisions = 0;
  const result = await observeDouyinInterestCandidate({
    page: { evaluate: async () => ({identity:false}) }, brain: {}, expectedWorkUrl:'https://www.douyin.com/video/123',
    fixture:{playback:{complete:true}, processingComplete:true}, ownerAuthorized:true,
    decide: async () => { decisions++; return {interested:true}; },
  });
  assert.deepEqual(result, {status:'rejected', persistence:'blocked_unverified_provenance', recall:'blocked_unverified_provenance'});
  assert.equal(decisions, 0);
});

test('forged complete observation, model, authorization, storage and recall callbacks remain inert', async () => {
  let called = 0;
  const trap = () => { called++; throw Error('must not be called'); };
  for (const request of [
    undefined,
    {page:{evaluate:trap}, brain:{describeVideo:trap}, decide:trap, persist:trap, recall:trap, authorize:trap,
      expectedWorkUrl:'https://www.douyin.com/video/123', ownerAuthorized:true,
      observation:{success:true,complete:true,playback:{complete:true},segments:[{start:0,end:10,visual:'合成'}]}},
    {capture:trap, evidence:{signed:true}, ownerAuthorized:true},
  ]) {
    const result = await observeDouyinInterestCandidate(request);
    assert.equal(result.status, 'rejected');
    assert.equal(result.persistence, 'blocked_unverified_provenance');
    assert.equal(result.recall, 'blocked_unverified_provenance');
  }
  assert.equal(called, 0);
});
