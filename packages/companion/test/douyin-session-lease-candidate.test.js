import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createSessionLease} from '../src/douyin-session-lease-candidate.js';

const peer = () => Object.assign(new EventEmitter(), {destroyed:false});
const deferred = () => { let resolve; const promise = new Promise(r => {resolve=r;}); return {promise,resolve}; };

test('default disabled and validates inputs before launch', () => {
  let launched = false;
  assert.throws(() => createSessionLease({launch:()=>{launched=true;}}), /disabled/);
  assert.throws(() => createSessionLease({enabled:true, ttlMs:0, peer:peer(), launch:()=>{launched=true;}}), /invalid/);
  assert.equal(launched, false);
});
test('disconnect during async start revokes the late resource once', async () => {
  const p=peer(), gate=deferred(); let closes=0;
  const lease=createSessionLease({enabled:true, peer:p, ttlMs:1000, launch:()=>gate.promise});
  await Promise.resolve();
  p.emit('close');
  assert.equal(lease.state,'stopping');
  gate.resolve({close:async()=>{closes++;}});
  assert.equal(await lease.started,false);
  assert.deepEqual(await lease.stopped,{reason:'peer_closed',cleaned:true});
  await lease.cancel(); assert.equal(closes,1); assert.equal(p.listenerCount('close'),0);
});
test('cancel before deferred launch prevents launch', async () => {
  let count=0;
  const lease=createSessionLease({enabled:true, peer:peer(), ttlMs:1000, launch:()=>{count++;}});
  const end=lease.cancel();
  assert.equal(await lease.started,false);
  assert.deepEqual(await end,{reason:'cancelled',cleaned:true}); assert.equal(count,0);
});
test('TTL closes running resource; cleanup failure is visible', async () => {
  const lease=createSessionLease({enabled:true,peer:peer(),ttlMs:20,launch:()=>({close(){throw Error('failed');}})});
  assert.equal(await lease.started,true);
  assert.deepEqual(await lease.stopped,{reason:'expired',cleaned:false});
  assert.equal(lease.state,'cleanup_failed');
});
test('launch failure is not claimed to be a clean teardown', async () => {
  const p=peer();
  const lease=createSessionLease({enabled:true,peer:p,ttlMs:1000,launch:()=>{throw Error('failed');}});
  assert.equal(await lease.started,false);
  assert.deepEqual(await lease.stopped,{reason:'launch_failed',cleaned:false});
  assert.equal(p.listenerCount('error'),0);
});
