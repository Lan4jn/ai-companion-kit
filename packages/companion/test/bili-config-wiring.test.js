import test from 'node:test';
import assert from 'node:assert/strict';
import { __debug, startBiliLiving, stopBiliLiving } from '../src/bili-living.js';
test('real start context receives disabled interaction and explicit caps', () => {
  const opts={danmakuEnabled:false,danmakuChance:0,coinChance:0,followEnabled:false,followDailyMax:3,dmDailyMax:4, commentEnabled:false,commentDailyMax:5};
  startBiliLiving({...opts,initialDelayMs:600000});
  try { for (const [k,v] of Object.entries(opts)) assert.equal(__debug.getInteractionContext()?.[k],v,k); }
  finally { stopBiliLiving(); }
});
test('comment disable applies to owner reach comments as well', () => {
  const gate = __debug.allowOwnerReachComment;
  assert.equal(gate({via:'comment'},{comment:true},{commentEnabled:false}),false);
  assert.equal(gate({via:'comment'},{comment:true},{commentEnabled:true}),true);
  assert.equal(gate({via:'comment'},{comment:false},{commentEnabled:true}),false);
  assert.equal(gate({via:'dm'},{comment:true},{commentEnabled:true}),false);
});
