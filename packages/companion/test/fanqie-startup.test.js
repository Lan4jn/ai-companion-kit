import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startFanqieAutonomous } from '../src/fanqie-startup.js';

test('disabled by default: no construction or scheduling', () => {
  const handle = startFanqieAutonomous({ createIntegration: () => { throw Error('must not construct'); } });
  assert.equal(handle.enabled, false);
  assert.doesNotThrow(() => handle.stop());
});

test('enabled startup connects the existing brain, directory, serial and willingness, and stops', async () => {
  const brain = { complete: async () => '{"want":true}' };
  const context = async () => 'real context';
  let received, starts = 0, stops = 0;
  const previous = process.env.PHONE_SERIAL;
  process.env.PHONE_SERIAL = 'device-1';
  let handle;
  try {
    handle = startFanqieAutonomous({ enabled: true, serial: 'device-1', brain, dataDir: '/data', context,
      createIntegration: options => { received = options; return { scheduler: { start() { starts++; }, stop() { stops++; } } }; },
    });
  } finally {
    if (previous === undefined) delete process.env.PHONE_SERIAL; else process.env.PHONE_SERIAL = previous;
  }
  assert.equal(handle.enabled, true);
  assert.equal(received.serial, 'device-1');
  assert.equal(received.brain, brain);
  assert.equal(received.memoryDir, '/data');
  assert.equal(await received.want(), true);
  assert.equal(starts, 1);
  handle.stop();
  handle.stop();
  assert.equal(stops, 1);
});

test('enabled startup rejects missing or mismatched device before construction', () => {
  const previous = process.env.PHONE_SERIAL;
  process.env.PHONE_SERIAL = 'dedicated';
  try {
    for (const serial of [undefined, '', 'other']) {
      assert.throws(() => startFanqieAutonomous({ enabled: true, serial, brain: { complete() {} }, dataDir: '/data',
        createIntegration() { throw new Error('must not construct'); } }), /PHONE_SERIAL/);
    }
  } finally {
    if (previous === undefined) delete process.env.PHONE_SERIAL; else process.env.PHONE_SERIAL = previous;
  }
});

test('truthy non-boolean enable flags do not start', () => {
  for (const enabled of ['true', 1, null]) {
    assert.equal(startFanqieAutonomous({ enabled, createIntegration() { throw Error('must not construct'); } }).enabled, false);
  }
});

test('willingness callback receives the supplied context and safely declines', async () => {
  const previous = process.env.PHONE_SERIAL;
  process.env.PHONE_SERIAL = 'device-1';
  let prompt, want;
  try {
    startFanqieAutonomous({ enabled: true, serial: 'device-1', dataDir: '/data', context: async () => 'context evidence',
      brain: { async complete(request) { prompt = request.prompt; return '{"want":false}'; } },
      createIntegration(options) { want = options.want; return { scheduler: { start() {}, stop() {} } }; },
    });
    assert.equal(await want(), false);
    assert.match(prompt, /context evidence/);
  } finally {
    if (previous === undefined) delete process.env.PHONE_SERIAL; else process.env.PHONE_SERIAL = previous;
  }
});


test('enabled startup supplies a goal core backed by the data directory', () => {
 const previous=process.env.PHONE_SERIAL; process.env.PHONE_SERIAL='device-1';
 let options;
 try {
  startFanqieAutonomous({enabled:true,serial:'device-1',brain:{complete:async()=>''},dataDir:process.env.TMPDIR,createIntegration(o){options=o;return {scheduler:{start(){},stop(){}}};}});
  assert.equal(typeof options.goalCore?.record,'function');
 } finally { if(previous===undefined) delete process.env.PHONE_SERIAL; else process.env.PHONE_SERIAL=previous; }
});


test('startup goal core persists actual asynchronous operations', async t => {
 const dir=await fs.mkdtemp(path.join(process.env.TMPDIR,'fanqie-start-core-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const previous=process.env.PHONE_SERIAL; process.env.PHONE_SERIAL='device-1';
 let core;
 try {
  startFanqieAutonomous({enabled:true,serial:'device-1',brain:{complete:async()=>''},dataDir:dir,createIntegration(o){core=o.goalCore;return {scheduler:{start(){},stop(){}}};}});
  await core.addGoal({id:'g',title:'read one page',target:1});
  await core.addDesire({id:'d',title:'read',goalId:'g'});
  await core.record({id:'e',type:'desire.completed',desireId:'d',amount:1,evidence:{source:'test',ref:'test'}});
  assert.equal((await core.snapshot()).goals.g.status,'completed');
  assert.equal(JSON.parse(await fs.readFile(path.join(dir,'fanqie-goals.json'),'utf8')).events.e.id,'e');
 } finally {if(previous===undefined)delete process.env.PHONE_SERIAL; else process.env.PHONE_SERIAL=previous;}
});


test('background goal input stays out of process arguments while lock is held', async t => {
  const { spawn } = await import('node:child_process');
  const dir = await fs.mkdtemp(path.join(process.env.TMPDIR, 'fanqie-argv-'));
  t.after(() => fs.rm(dir, {recursive:true, force:true}));
  const lock = spawn('flock', ['-x', path.join(dir, 'fanqie-goals.json.lock'), process.execPath, '-e', "console.log('ready'); process.stdin.resume()"], {stdio:['pipe','pipe','pipe']});
  t.after(() => lock.kill());
  await new Promise((resolve, reject) => { lock.stdout.once('data', resolve); lock.once('error', reject); });
  const previous = process.env.PHONE_SERIAL; process.env.PHONE_SERIAL = 'device-1';
  let core;
  try {
    startFanqieAutonomous({enabled:true,serial:'device-1',brain:{complete:async()=>''},dataDir:dir,createIntegration(o){core=o.goalCore;return {scheduler:{start(){},stop(){}}};}});
  } finally { if(previous === undefined) delete process.env.PHONE_SERIAL; else process.env.PHONE_SERIAL=previous; }
  const secret = 'PRIVATE_OCR_CONTENT_8c4072';
  const pending = core.addGoal({id:'g', title:secret, target:1});
  let settled = false; pending.then(() => { settled = true; }, () => { settled = true; });
  let childArgs = '';
  for (let i=0;i<100;i++) {
    const children = (await fs.readFile(`/proc/${process.pid}/task/${process.pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean);
    for (const pid of children) {
      try { const cmd=(await fs.readFile(`/proc/${pid}/cmdline`)).toString(); if(cmd.includes('createGoalCore')) childArgs=cmd; } catch {}
    }
    if(childArgs) break;
    await new Promise(r=>setTimeout(r,10));
  }
  try { assert.ok(childArgs, 'background child observed'); assert.ok(!childArgs.includes(secret), 'sensitive input leaked in argv');
    await new Promise(r => setTimeout(r, 200));
    assert.equal(settled, false, 'lock holds the asynchronous operation'); }
  finally { lock.stdin.end(); await pending; }
  assert.equal((await core.snapshot()).goals.g.title, secret);
});


test('background failures do not expose private data or child stderr', async t => {
  const dir = await fs.mkdtemp(path.join(process.env.TMPDIR, 'fanqie-errors-'));
  t.after(() => fs.rm(dir, {recursive:true, force:true}));
  const secret = 'PRIVATE_FAILURE_PATH_7dba';
  const notDirectory = path.join(dir, secret);
  await fs.writeFile(notDirectory, 'file');
  const previous = process.env.PHONE_SERIAL; process.env.PHONE_SERIAL = 'device-1';
  let core;
  try { startFanqieAutonomous({enabled:true, serial:'device-1', brain:{complete:async()=>''}, dataDir:notDirectory, createIntegration(o){core=o.goalCore;return {scheduler:{start(){},stop(){}}};}}); }
  finally { if(previous === undefined) delete process.env.PHONE_SERIAL; else process.env.PHONE_SERIAL=previous; }
  await assert.rejects(core.addGoal({id:'g',title:secret,target:1}), error => {
    assert.equal(error.message, 'Background goal operation failed');
    assert.ok(!String(error.stack).includes(secret));
    return true;
  });
  const circular = {secret}; circular.self = circular;
  await assert.rejects(core.addGoal(circular), {message:'Background goal operation failed'});
});
