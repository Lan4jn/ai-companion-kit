import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';

const fixture=new URL('./group-bridge-process-fixture.js',import.meta.url).pathname;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<500;i++){if(fn())return;await wait(10)}throw Error('fixture timeout')}
function child(dir,id,gate,race=false,extra={}){const p=spawn(process.execPath,[fixture,dir,id,gate],{env:{...process.env,BRIDGE_FORCE_RACE:race?'1':'0',...extra},stdio:['ignore','pipe','pipe']}); let output='';p.stdout.on('data',x=>output+=x);p.stderr.on('data',x=>output+=x);p.result=new Promise(r=>p.on('exit',(code,signal)=>r({code,signal,output})));return p}
function lines(dir){try{return fs.readFileSync(path.join(dir,'sent'),'utf8').trim().split('\n').filter(Boolean)}catch{return []}}

test('distinct simultaneous processes respect one daily group quota',async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'bridge-process-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const gate=path.join(dir,'go');const a=child(dir,'a',gate,true),b=child(dir,'b',gate,true);t.after(()=>{a.kill('SIGKILL');b.kill('SIGKILL')});
 await until(()=>fs.existsSync(path.join(dir,'ready-a'))&&fs.existsSync(path.join(dir,'ready-b')));fs.writeFileSync(gate,'');
 const results=await Promise.all([a.result,b.result]);assert.equal(results.every(x=>x.code===0),true,JSON.stringify(results));
 assert.equal(lines(dir).length,1,`daily quota exceeded: ${JSON.stringify(results)}`);
});

test('SIGKILL after send leaves reservation preventing replay',async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'bridge-kill-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const gate=path.join(dir,'go');const a=child(dir,'same',gate);t.after(()=>a.kill('SIGKILL'));await until(()=>fs.existsSync(path.join(dir,'ready-same')));fs.writeFileSync(gate,'');await until(()=>lines(dir).length===1);a.kill('SIGKILL');assert.equal((await a.result).signal,'SIGKILL');
 const b=child(dir,'same',gate);t.after(()=>b.kill('SIGKILL'));const result=await b.result;assert.equal(result.code,0,result.output);assert.match(result.output,/unknown|denied/);assert.equal(lines(dir).length,1);
});

test('failed reservation fsync blocks sending and replay',async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'bridge-fsync-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const gate=path.join(dir,'go');fs.writeFileSync(gate,'');
 const a=child(dir,'broken',gate,false,{BRIDGE_FAIL_FSYNC:'1',BRIDGE_QUOTA:'10'});const first=await a.result;assert.equal(first.code,0,first.output);assert.match(first.output,/unknown/);assert.equal(lines(dir).length,0);
 const b=child(dir,'broken',gate,false,{BRIDGE_QUOTA:'10'});const replay=await b.result;assert.equal(replay.code,0,replay.output);assert.match(replay.output,/unknown/);assert.equal(lines(dir).length,0);
});
