import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGoalCore } from '../src/goal-core.js';
import { createFanqieIntegration } from '../src/fanqie-integration.js';
import { spawnSync } from 'node:child_process';

function setup() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'goal-pair-'));
  return { dir, file: path.join(dir, 'goals.json') };
}

test('legacy stranded goal is recovered and active desire reused after reload', () => {
  const {file,dir}=setup();
  try {
    let core=createGoalCore({file});
    core.addGoal({id:'old',title:'阅读《测试书》的一页',target:1});
    const pair = {goal:{id:'new',title:'阅读《测试书》的一页',target:1},desire:{id:'new',title:'阅读《测试书》的一页',goalId:'new'},reuseActiveTitle:true};
    assert.deepEqual(core.ensureGoalDesire(pair),{goalId:'old',desireId:'new'});
    core=createGoalCore({file});
    assert.deepEqual(core.ensureGoalDesire({...pair,goal:{...pair.goal,id:'other'},desire:{...pair.desire,id:'other',goalId:'other'}}),{goalId:'old',desireId:'new'});
    assert.equal(Object.keys(core.snapshot().desires).length,1);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('simultaneous pair recovery creates one active desire across processes', async () => {
  const {file,dir}=setup();
  try {
    const core=createGoalCore({file}); core.addGoal({id:'old',title:'book',target:1});
    const url=new URL('../src/goal-core.js',import.meta.url).href;
    const {spawn}=await import('node:child_process');
    const script=`import {createGoalCore} from ${JSON.stringify(url)}; const id=process.argv[2]; createGoalCore({file:process.argv[1]}).ensureGoalDesire({goal:{id,title:'book',target:1},desire:{id,title:'book',goalId:id},reuseActiveTitle:true});`;
    const run=id=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,['--input-type=module','-e',script,file,id]);let err='';p.stderr.on('data',s=>err+=s);p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(Error(err)));});
    await Promise.all(Array.from({length:5},(_,i)=>run(`id${i}`)));
    const state=createGoalCore({file}).snapshot();
    assert.equal(Object.keys(state.goals).length,1); assert.equal(Object.keys(state.desires).length,1);
    assert.equal(Object.values(state.desires)[0].goalId,'old');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('web pair is persisted in a single transaction', () => {
  const {file, dir} = setup();
  try {
    const url = new URL('../src/desire-engine.js', import.meta.url).href;
    const shim = path.join(dir,'flock');
    fs.writeFileSync(shim, '#!/bin/sh\nif [ -e "$PAIR_MARKER" ]; then exit 99; fi\ntouch "$PAIR_MARKER"\nexec /usr/bin/flock "$@"\n', {mode:0o755});
    const script = `import {formWebDesire} from ${JSON.stringify(url)}; formWebDesire(process.argv[1],{topic:'测试',reason:'测试'});`;
    const child=spawnSync(process.execPath,['--input-type=module','-e',script,dir],{encoding:'utf8',env:{...process.env, PATH:dir+':'+process.env.PATH, PAIR_MARKER:path.join(dir,'marker')}});
    assert.equal(child.status,0,child.stderr);
    const state=createGoalCore({file:path.join(dir,'web-goals.json')}).snapshot();
    assert.equal(Object.keys(state.goals).length,1);
    assert.equal(Object.keys(state.desires).length,1);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('fanqie uses one atomic pair operation before reading', async () => {
  const {file, dir} = setup();
  try {
    const real = createGoalCore({file}); let calls = 0;
    const core = {snapshot:()=>real.snapshot(), record:e=>real.record(e), ensureGoalDesire:v=>{calls++; return real.ensureGoalDesire(v);}};
    const integration = createFanqieIntegration({serial:'test',brain:{complete:async()=>'{"want":true,"bookTitle":"测试书","goal":"read_page"}'},memoryDir:dir,want:async()=>true,goalCore:core,mutex:{tryBackground:async fn=>{await fn();return true;}},online:async()=>true,navigate:async()=>({ok:true,bookTitle:'测试书'}),progress:async()=>null});
    await integration.run();
    assert.equal(calls, 1);
    const state = real.snapshot();
    assert.equal(Object.keys(state.goals).length, 1);
    assert.equal(Object.values(state.desires)[0].status, 'failed');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('pair creation rejects an invalid desire without persisting its goal', () => {
  const {file, dir} = setup();
  try {
    const core = createGoalCore({file});
    assert.throws(() => core.ensureGoalDesire({goal:{id:'g',title:'goal',target:1},desire:{id:'',title:'desire',goalId:'g'}}), /id/);
    assert.deepEqual(core.snapshot().goals, {});
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
