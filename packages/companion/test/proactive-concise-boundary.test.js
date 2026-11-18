import test from 'node:test';
import assert from 'node:assert/strict';
import { startProactive, stopProactive } from '../src/proactive.js';
import { Humanizer } from '../src/humanize.js';
import { loopGuard } from '../src/loop-guard.js';

async function run(text, human = new Humanizer({enabled:false})) {
  const oldSet = globalThis.setTimeout, oldClear = globalThis.clearTimeout;
  const timers = [], sent = [], turns = [];
  globalThis.setTimeout = fn => (timers.push(fn), fn);
  globalThis.clearTimeout = () => {};
  const key = 'private:concise-proactive-test';
  loopGuard.reset(key);
  try {
    startProactive({ownerId:'concise-proactive-test', activeStart:0, activeEnd:0, initialDelayMs:0,
      brain:{reply:async()=>({text:JSON.stringify({want:true,target:'dad',text})})},
      memory:{sessionTurns:()=>[],logTurn:t=>turns.push(t)},
      bot:{send:async(_key, part)=>{sent.push(part); return {ok:true};}}, human});
    await timers.shift()();
    return {sent, turns};
  } finally { await stopProactive(); globalThis.setTimeout=oldSet; globalThis.clearTimeout=oldClear; loopGuard.reset(key); }
}

test('proactive split reply of 51 code points never starts delivery', async()=>{
  const {sent,turns}=await run('甲'.repeat(26)+'\n\n'+'乙'.repeat(25));
  assert.deepEqual(sent,[]); assert.deepEqual(turns,[]);
});
test('proactive 50 code points are permitted', async()=>{
  const {sent}=await run('甲'.repeat(50));
  assert.equal([...sent.join('')].length,50);
});
test('主动消息及异常日志不泄露正文', async()=>{
  const secret='保密正文标记';
  const logs=[]; const log=console.log, warn=console.warn;
  console.log=(...args)=>logs.push(args.join(' ')); console.warn=(...args)=>logs.push(args.join(' '));
  try {
    await run(secret);
    await run('另一个内容', {say:async()=>{throw new Error(secret)}});
  } finally { console.log=log; console.warn=warn; }
  assert(!logs.join('\n').includes(secret));
});

test('humanizer cannot add output past the cumulative limit', async()=>{
  const human={say:async(_text,{send})=>{await send('甲'.repeat(30)); await send('乙'.repeat(21));}};
  const {sent}=await run('你好',human);
  assert.equal([...sent.join('')].length,30);
});
