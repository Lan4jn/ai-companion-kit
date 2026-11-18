import test from 'node:test';
import assert from 'node:assert/strict';
import { Brain } from '../src/brain.js';
import { createTiebaScheduler } from '../src/tieba-scheduler.js';
import { createTiebaReader } from '../src/tieba-reader.js';

test('HTTP model failure is structured and never leaks provider details', async () => {
  const prior = globalThis.fetch, error = console.error, logs = [];
  console.error = (...a) => logs.push(a.join(' '));
  globalThis.fetch = async () => ({ ok: false, status: 429, text: async () => 'SECRET' });
  try {
    const brain = new Brain({ apiKey: 'SECRET', baseUrl: 'https://example.invalid/?SECRET', model: 'SECRET', memory: {} });
    const scheduler = createTiebaScheduler({enabled:true, brain, reader:{run:async()=>{throw Error('must not browse');}}});
    const result = await scheduler.tick();
    assert.deepEqual(result, {status:'model_failed', error:{category:'http', status:429}});
    assert.doesNotMatch(JSON.stringify(result) + logs.join(' '), /SECRET/);
  } finally { globalThis.fetch = prior; console.error = error; }
});

test('transport and response failures are safely classified through both decision paths', async () => {
  const prior = globalThis.fetch, oldError = console.error, logs = [];
  console.error = (...args) => logs.push(args.join(' '));
  const brain = new Brain({apiKey:'SECRET',baseUrl:'https://example.invalid/?SECRET',model:'SECRET',memory:{}});
  const url = 'https://tieba.baidu.com/p/123';
  const cases = [
    [async () => { throw Object.assign(new Error('SECRET'), { name:'TimeoutError' }); }, 'timeout'],
    [async () => { throw new Error('SECRET'); }, 'network'],
    [async () => ({ok:true,json:async()=>{throw new SyntaxError('SECRET');}}), 'response_format'],
    [async () => ({ok:true,json:async()=>({choices:[]})}), 'model_unavailable'],
    [async () => ({ok:true,json:async()=>({choices:[{message:{content:'SECRET'}}]})}), 'response_format'],
  ];
  try {
    for (const [fetcher, category] of cases) {
      globalThis.fetch = fetcher;
      const reader = createTiebaReader({enabled:true, dir:process.env.TMPDIR, brain, source:{list:async()=>[{url}], read:async()=>({url,forum:'肥鱼避难所吧',title:'合成',body:'合成'})}});
      const scheduler = createTiebaScheduler({enabled:true,brain,reader});
      const first = await scheduler.tick(), second = await reader.run();
      assert.equal(first.error.category, category);
      assert.equal(second.error.category, category);
      assert.doesNotMatch(JSON.stringify([first,second]) + logs.join(' '), /SECRET/);
    }
  } finally { globalThis.fetch=prior; console.error=oldError; }
});

test('declining browse stops without touching source', async () => {
  let reads=0;
  const scheduler=createTiebaScheduler({enabled:true,brain:{complete:async()=>'{"browse":false}'},reader:{run:async()=>{reads++;}}});
  assert.deepEqual(await scheduler.tick(),{status:'declined'});
  assert.equal(reads,0);
});

test('scheduled failures emit only safe diagnostic fields', async () => {
  let callback; const logs=[]; const previous=console.warn;
  console.warn=(...args)=>logs.push(args.join(' '));
  try {
    const scheduler=createTiebaScheduler({enabled:true,brain:{complete:async()=>'{"secret":"SECRET"}'},reader:{run:async()=>{}},setTimer:fn=>{callback=fn; return 1;},clearTimer:()=>{}});
    scheduler.start(); await callback(); await scheduler.stop();
    assert.match(logs.join(' '), /response_format/);
    assert.doesNotMatch(logs.join(' '), /SECRET/);
  } finally {console.warn=previous;}
});
