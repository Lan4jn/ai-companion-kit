import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createSessionLease} from '../src/douyin-session-lease-candidate.js';
const peer = () => Object.assign(new EventEmitter(), {destroyed:false});
const deferred = () => { let resolve; const promise = new Promise(r => {resolve=r;}); return {promise, resolve}; };

test('stuck launch is aborted and reported unconfirmed, late resource still closed', async () => {
  const gate=deferred(), p=peer(); let signal, closes=0;
  const lease=createSessionLease({enabled:true, peer:p, ttlMs:1000, shutdownTimeoutMs:30,
    launch:({signal:s})=>{signal=s; return gate.promise;}});
  await Promise.resolve();
  const end=lease.cancel();
  assert.equal(signal.aborted,true);
  assert.deepEqual(await end,{reason:'cancelled',cleaned:false});
  assert.equal(lease.state,'cleanup_failed');
  assert.equal(p.listenerCount('close'),0);
  gate.resolve({close(){closes++;}});
  assert.equal(await lease.started,false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closes,1);
  assert.equal(lease.state,'cleanup_failed');
});

test('stuck close is bounded and never falsely marked clean after it resolves', async () => {
  const gate=deferred(); let closes=0;
  const lease=createSessionLease({enabled:true, peer:peer(), ttlMs:1000, shutdownTimeoutMs:30,
    launch:()=>({close(){closes++; return gate.promise;}})});
  assert.equal(await lease.started,true);
  assert.deepEqual(await lease.cancel(),{reason:'cancelled',cleaned:false});
  gate.resolve(); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(lease.state,'cleanup_failed');
  assert.equal(closes,1);
});

test('invalid shutdown deadline cannot launch', () => {
  for (const shutdownTimeoutMs of [0,-1,Infinity,60001]) {
    assert.throws(()=>createSessionLease({enabled:true, peer:peer(), ttlMs:1000, shutdownTimeoutMs, launch(){throw Error('launch');}}),/invalid/);
  }
});

test('null from an already launched backend is not evidence of cleanup', async () => {
  const gate=deferred();
  const lease=createSessionLease({enabled:true, peer:peer(), ttlMs:1000, shutdownTimeoutMs:100, launch:()=>gate.promise});
  await Promise.resolve();
  const end=lease.cancel();
  gate.resolve(null);
  assert.equal(await lease.started,false);
  assert.deepEqual(await end,{reason:'cancelled',cleaned:false});
});

test('expiry aborts a stuck backend and reports uncertainty', async () => {
  let signal;
  const lease=createSessionLease({enabled:true, peer:peer(), ttlMs:20, shutdownTimeoutMs:25,
    launch:({signal:s})=>{signal=s; return new Promise(()=>{});}});
  assert.deepEqual(await lease.stopped,{reason:'expired',cleaned:false});
  assert.equal(signal.aborted,true);
  assert.equal(lease.state,'cleanup_failed');
});
