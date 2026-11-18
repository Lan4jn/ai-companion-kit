import test from 'node:test';
import assert from 'node:assert/strict';
import { decideWebSurfing, browseWebTopic, startWebLiving, stopWebLiving } from '../src/web-living.js';
import fs from 'node:fs';
import path from 'node:path';
test('web model exceptions never expose synthetic credentials in logs', async () => {
 const old=console.warn, logs=[]; console.warn=(...a)=>logs.push(a.join(' '));
 try { await decideWebSurfing({brain:{complete:async()=>{throw Error('synthetic-body-token-XYZ')}},dataDir:process.env.TMPDIR}); }
 finally { console.warn=old; }
 assert.ok(logs.length); assert.ok(!logs.join('\n').includes('synthetic-body-token-XYZ'));
});

test('digest failure does not log synthetic page or credentials', async t => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'web-log-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const oldLog=console.log, oldWarn=console.warn, logs=[];
 console.log=console.warn=(...a)=>logs.push(a.join(' '));
 try {
  await browseWebTopic({topic:'Steam游戏',memory:{dir},search:async()=>({success:true,text:'1. Steam游戏介绍\n(来源: web https://example.com/a)'}),brain:{complete:async p=>{if(p.prompt.includes('想不想再花')) return {deep:false}; throw Error('synthetic-page-credential-XYZ');}}});
 } finally {console.log=oldLog;console.warn=oldWarn;}
 assert.ok(logs.join('\n').includes('digest-failed'));
 assert.ok(!logs.join('\n').includes('synthetic-page-credential-XYZ'));
});

test('scheduled decision reason is not logged', async () => {
 const oldTimeout=globalThis.setTimeout, oldLog=console.log, logs=[], callbacks=[];
 globalThis.setTimeout=(fn)=>{callbacks.push(fn);return 1}; console.log=(...a)=>logs.push(a.join(' '));
 try {
  startWebLiving({brain:{complete:async()=>({want:false,reason:'synthetic-reason-secret-XYZ'})},memory:{dir:process.env.TMPDIR}});
  await callbacks[1](); await stopWebLiving();
 } finally {globalThis.setTimeout=oldTimeout; console.log=oldLog;}
 assert.ok(logs.join('\n').includes('decision-declined'));
 assert.ok(!logs.join('\n').includes('synthetic-reason-secret-XYZ'));
});
