import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadingScheduler } from '../src/fanqie-scheduler.js';
import { startFanqieAutonomous } from '../src/fanqie-startup.js';
import { spawn } from 'node:child_process';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('stop drains an in-flight reading and rejects new ticks', async () => {
  const gate = deferred();
  let runs = 0;
  const scheduler = createReadingScheduler({want: async () => true, run: async () => { runs++; await gate.promise; return {ok:true}; }});
  const work = scheduler.tick();
  await new Promise(r => setImmediate(r));
  let done = false;
  const stopping = Promise.resolve(scheduler.stop()).then(() => { done = true; });
  await new Promise(r => setImmediate(r));
  assert.equal(done, false);
  assert.equal((await scheduler.tick()).reason, 'stopped');
  gate.resolve();
  await Promise.all([work, stopping]);
  assert.equal(runs, 1);
});

test('production Fanqie handle returns the scheduler drain', async () => {
  const gate = deferred();
  const old = process.env.PHONE_SERIAL;
  process.env.PHONE_SERIAL = 'test-device';
  try {
    const handle = startFanqieAutonomous({enabled:true, serial:'test-device', brain:{complete(){}}, dataDir:'/unused', createIntegration: () => ({scheduler:{start(){},stop(){return gate.promise;}}})});
    let done = false;
    const stopping = Promise.resolve(handle.stop()).then(() => { done = true; });
    await new Promise(r => setImmediate(r));
    assert.equal(done, false);
    gate.resolve();
    await stopping;
  } finally { if (old === undefined) delete process.env.PHONE_SERIAL; else process.env.PHONE_SERIAL = old; }
});


test('real SIGTERM waits for the active Fanqie producer before exiting', async () => {
  const code = `
    import { setupProductionFanqie } from './src/index.js';
    import { createReadingScheduler } from './src/fanqie-scheduler.js';
    let release;
    const gate = new Promise(r => { release = r; });
    const scheduler = createReadingScheduler({want:async()=>true, run:async()=>{console.log('RUNNING'); await gate; console.log('FINISHED');}});
    scheduler.tick();
    setupProductionFanqie({cfg:{}, brain:{}, start:()=>({stop:()=>scheduler.stop()}), shutdownTimeoutMs:2000});
    process.on('SIGTERM', () => setTimeout(release, 120));
    setInterval(()=>{},1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module','-e',code], {cwd:process.cwd(), stdio:['ignore','pipe','pipe']});
  let stdout='', stderr='';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const ended = new Promise(resolve => child.once('exit', (code, signal) => resolve({code, signal})));
  try {
    await Promise.race([new Promise((resolve,reject)=>{ const timer=setInterval(()=>{if(stdout.includes('RUNNING')){clearInterval(timer);resolve();}},5); child.once('exit',()=>{clearInterval(timer);reject(new Error(stderr));}); }), new Promise((_,reject)=>setTimeout(()=>reject(new Error('startup timeout')),3000))]);
    child.kill('SIGTERM');
    const result = await ended;
    assert.deepEqual(result,{code:0,signal:null});
    assert.match(stdout,/FINISHED/);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
});
