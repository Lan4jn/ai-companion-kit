import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createGoalCore } from '../src/goal-core.js';

const moduleUrl = new URL('../src/goal-core.js', import.meta.url).href;

test('independent processes serialize read-modify-write without losing events', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/root/.hermes/cache/scratch', 'goal-race-'));
  try {
    const file = path.join(dir, 'state.json');
    createGoalCore({ file }).addGoal({ id: 'g', title: 'goal', target: 1000 });
    const script = `import { createGoalCore } from ${JSON.stringify(moduleUrl)};
      const c = createGoalCore({ file: process.argv[1] });
      for (let i=0; i<20; i++) c.record({ id: process.argv[2]+':'+i, type:'goal.progress', goalId:'g', amount:1, evidence:{source:'test',ref:'r'} });`;
    await Promise.all(Array.from({ length: 8 }, (_, i) => new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ['--input-type=module', '-e', script, file, String(i)], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = ''; p.stderr.on('data', x => { err += x; }); p.on('error', reject); p.on('exit', code => code === 0 ? resolve() : reject(new Error(err)));
    })));
    const state = createGoalCore({ file }).snapshot();
    assert.equal(Object.keys(state.events).length, 160);
    assert.equal(state.goals.g.progress, 160);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

 test('a killed writer cannot truncate committed state and later writers recover', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/root/.hermes/cache/scratch', 'goal-crash-'));
  try {
    const file = path.join(dir, 'state.json');
    const core = createGoalCore({ file });
    core.addGoal({ id: 'g', title: 'goal', target: 10 });
    const preload = path.join(dir, 'crash.cjs');
    fs.writeFileSync(preload, `const fs = require('node:fs'); const original = fs.renameSync; fs.renameSync = function(a,b) { if (b === process.env.GOAL_CRASH_FILE) process.kill(process.pid, 'SIGKILL'); return original.apply(this, arguments); };`);
    const script = `import { createGoalCore } from ${JSON.stringify(moduleUrl)}; createGoalCore({ file: process.argv[1] }).record({ id:'crash', type:'goal.progress', goalId:'g', amount:1, evidence:{source:'test',ref:'r'} });`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, file], { env: { ...process.env, NODE_OPTIONS: `--require=${preload}`, GOAL_CRASH_FILE: file }, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.equal(core.snapshot().goals.g.progress, 0);
    core.record({ id:'after', type:'goal.progress', goalId:'g', amount:1, evidence:{source:'test',ref:'r'} });
    assert.equal(core.snapshot().goals.g.progress, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('concurrent duplicate events apply exactly once', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/root/.hermes/cache/scratch', 'goal-duplicate-'));
  try {
    const file = path.join(dir, 'state.json');
    const core = createGoalCore({ file });
    core.addGoal({ id:'g', title:'goal', target:10 });
    const script = `import { createGoalCore } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(createGoalCore({file:process.argv[1]}).record({id:'same',type:'goal.progress',goalId:'g',amount:1,evidence:{source:'test',ref:'r'}})));`;
    const results = await Promise.all(Array.from({length:4}, () => new Promise((resolve,reject) => {
      const p = spawn(process.execPath, ['--input-type=module','-e',script,file]); let out='', err='';
      p.stdout.on('data', x => { out += x; }); p.stderr.on('data', x => { err += x; });
      p.on('error',reject); p.on('exit',code => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err)));
    })));
    assert.equal(results.filter(x => x.applied).length, 1);
    assert.equal(core.snapshot().goals.g.progress, 1);
    assert.equal(Object.keys(core.snapshot().events).length, 1);
  } finally { fs.rmSync(dir, { recursive:true, force:true }); }
});

// Hold the real lock while a caller attempts a write, without touching live data.
test('public options cannot bypass the transaction lock', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/root/.hermes/cache/scratch', 'goal-bypass-'));
  const file = path.join(dir, 'state.json');
  const holder = spawn('flock', ['-x', `${file}.lock`, process.execPath, '-e', "console.log('ready'); process.stdin.resume()"], { stdio: ['pipe','pipe','pipe'] });
  let writer;
  try {
    await new Promise((resolve, reject) => { holder.stdout.once('data', resolve); holder.once('error', reject); holder.once('exit', () => reject(new Error('lock holder exited early'))); });
    const script = `import { createGoalCore } from ${JSON.stringify(moduleUrl)}; createGoalCore({file:process.argv[1], __goalCoreLocked:true}).addGoal({id:'g',title:'g',target:1});`;
    writer = spawn(process.execPath, ['--input-type=module','-e',script,file]);
    let exited = false; const done = new Promise((resolve, reject) => { writer.once('error', reject); writer.once('exit', code => { exited = true; code === 0 ? resolve() : reject(new Error(`writer exit ${code}`)); }); });
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(exited, false, 'writer ignored held lock');
    holder.stdin.end(); await done;
    assert.equal(createGoalCore({file}).snapshot().goals.g.id, 'g');
  } finally { holder.kill(); if (writer) writer.kill(); fs.rmSync(dir,{recursive:true,force:true}); }
});

test('symlinked file and directory aliases share state and locking', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/root/.hermes/cache/scratch', 'goal-alias-'));
  try {
    const realDir = path.join(dir, 'real'); fs.mkdirSync(realDir);
    const file = path.join(realDir, 'state.json');
    createGoalCore({file}).addGoal({id:'g',title:'goal',target:100});
    const aliasDir = path.join(dir, 'alias-dir'); fs.symlinkSync(realDir, aliasDir);
    const aliasFile = path.join(dir, 'alias.json'); fs.symlinkSync(file, aliasFile);
    const script = `import {createGoalCore} from ${JSON.stringify(moduleUrl)}; const c=createGoalCore({file:process.argv[1]}); for(let i=0;i<8;i++) c.record({id:process.argv[2]+':'+i,type:'goal.progress',goalId:'g',amount:1,evidence:{source:'test',ref:'r'}});`;
    const files = [file, path.join(aliasDir,'state.json'), aliasFile];
    await Promise.all(files.map((p,i) => new Promise((resolve,reject) => { const child=spawn(process.execPath,['--input-type=module','-e',script,p,String(i)]); let err=''; child.stderr.on('data',x=>err+=x); child.on('error',reject); child.on('exit',code=>code===0?resolve():reject(new Error(err))); })));
    const state = createGoalCore({file}).snapshot();
    assert.equal(state.goals.g.progress,24);
    assert.equal(Object.keys(state.events).length,24);
    assert.equal(fs.lstatSync(aliasFile).isSymbolicLink(),true);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('a dangling file symlink preserves its identity when initialized', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/root/.hermes/cache/scratch','goal-dangling-'));
  try {
    const file=path.join(dir,'nested','state.json'), alias=path.join(dir,'alias.json');
    fs.symlinkSync(file,alias);
    createGoalCore({file:alias}).addGoal({id:'g',title:'goal',target:1});
    assert.equal(fs.lstatSync(alias).isSymbolicLink(),true);
    assert.equal(createGoalCore({file}).snapshot().goals.g.id,'g');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('hard linked stores are rejected rather than silently split on rename', () => {
  const dir=fs.mkdtempSync(path.join(process.env.TMPDIR || '/root/.hermes/cache/scratch','goal-hardlink-'));
  try {
    const file=path.join(dir,'state.json'), alias=path.join(dir,'alias.json');
    createGoalCore({file}).addGoal({id:'g',title:'goal',target:1});
    fs.linkSync(file,alias);
    assert.throws(() => createGoalCore({file:alias}), /hard-linked/);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
