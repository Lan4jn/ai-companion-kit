import test from 'node:test';
import assert from 'node:assert/strict';
import { startProactive, stopProactive } from '../src/proactive.js';
import { loopGuard } from '../src/loop-guard.js';
import { setupProductionFanqie } from '../src/index.js';
import { EventEmitter } from 'node:events';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('stop drains a pending decision and prevents its later send', async () => {
  const decision = deferred(), entered = deferred(); let sends = 0;
  startProactive({ ownerId: 'shutdown-test', activeStart: 0, activeEnd: 0, initialDelayMs: 0,
    brain: { reply: () => { entered.resolve(); return decision.promise; } },
    memory: { sessionTurns: () => [], logTurn() {} }, bot: { send: async () => { sends++; return {ok:true}; } } });
  await entered.promise;
  const stopping = stopProactive();
  try { assert.equal(typeof stopping?.then, 'function'); }
  finally { decision.resolve({text: JSON.stringify({want:true,text:'hello'})}); }
  await stopping;
  await new Promise(r => setTimeout(r, 20));
  assert.equal(sends, 0);
});

test('stop waits for in-flight send and blocks subsequent humanized chunks', async () => {
  const sent = deferred(), entered = deferred(); const calls = []; const turns = [];
  startProactive({ ownerId: 'shutdown-chunks', activeStart: 0, activeEnd: 0, initialDelayMs: 0,
    brain: { reply: async () => ({text: '{"want":true,"text":"hello"}'}) },
    memory: { sessionTurns: () => [], logTurn: t => turns.push(t) },
    bot: { send: async (key, text) => { calls.push(text); entered.resolve(); return sent.promise; } },
    human: { say: async (text, {send}) => { await send('one'); await send('two'); } } });
  await entered.promise;
  let done = false; const stopping = stopProactive().then(() => { done = true; });
  await new Promise(r => setTimeout(r, 10)); assert.equal(done, false);
  sent.resolve({ok:true}); await stopping;
  assert.deepEqual(calls, ['one']); assert.equal(turns[0].text, 'one');
});

test('unconfirmed in-flight send times out honestly and cannot launch another chunk', async () => {
  const sent = deferred(), entered = deferred(); let calls = 0; const turns = [];
  startProactive({ ownerId: 'shutdown-unknown', activeStart: 0, activeEnd: 0, initialDelayMs: 0,
    brain: { reply: async () => ({text: '{"want":true,"text":"hello"}'}) },
    memory: { sessionTurns: () => [], logTurn: t => turns.push(t) },
    bot: { send: async () => { calls++; entered.resolve(); return sent.promise; } },
    human: { say: async (text, {send}) => { await send('one'); await send('two'); } } });
  await entered.promise;
  await assert.rejects(stopProactive({timeoutMs: 10}), /未知/);
  assert.equal(calls, 1); assert.deepEqual(turns, []);
  sent.resolve({ok:false,outcome:'unknown'});
  await assert.rejects(stopProactive({timeoutMs: 100}), /未知/);
  assert.equal(calls, 1); assert.deepEqual(turns, []);
});

test('unknown delivery does not permit a humanizer to retry or send more chunks', async () => {
  const entered = deferred(); let calls = 0;
  const key = 'private:unknown-retry'; loopGuard.reset(key);
  startProactive({ownerId:'unknown-retry', activeStart:0, activeEnd:0, initialDelayMs:0,
    brain:{reply:async()=>({text:'{"want":true,"text":"hello"}'})},
    memory:{sessionTurns:()=>[],logTurn(){}},
    bot:{send:async()=>{ calls++; return {ok:false,outcome:'unknown'}; }},
    human:{say:async (_text,{send})=>{ try { await send('first'); } catch {} try { await send('second'); } catch {} entered.resolve(); }} });
  await entered.promise; await assert.rejects(stopProactive(), /未知/);
  assert.equal(calls, 1); assert.equal(loopGuard.count(key), 1); loopGuard.reset(key);
});

test('unified shutdown waits for the real proactive producer before transport drain', async () => {
  const entered = deferred(), decision = deferred(); const signals = new EventEmitter(); const events = [];
  const exited = new Promise(resolve => { signals.exit = resolve; });
  startProactive({ownerId:'shutdown-integration', activeStart:0, activeEnd:0, initialDelayMs:0,
    brain:{reply:()=>{entered.resolve();return decision.promise;}},
    memory:{sessionTurns:()=>[],logTurn(){}},bot:{send:async()=>{events.push('send');return {ok:true};}}});
  await entered.promise;
  setupProductionFanqie({cfg:{},signals,shutdownTimeoutMs:1000,start:()=>({stop(){}}),
    stopOthers:()=>[stopProactive()],drain:async()=>events.push('drain')});
  signals.emit('SIGTERM'); await new Promise(r=>setImmediate(r)); assert.deepEqual(events,[]);
  decision.resolve({text:'{"want":true,"text":"hello"}'});
  assert.equal(await exited,0); assert.deepEqual(events,['drain']);
});
