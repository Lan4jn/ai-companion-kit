import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
const base=fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bili-procs-'));
const moduleUrl = new URL('../src/bili-living.js',import.meta.url).href;
const browserUrl = new URL('../src/bili-browser.js',import.meta.url).href;
const script = `import fs from 'node:fs'; import path from 'node:path'; import {__debug} from ${JSON.stringify(moduleUrl)};
 import {browserComment,closeWatchBrowser} from ${JSON.stringify(browserUrl)}; import {chromium} from 'playwright-core';
 const sent=async()=>{const files=fs.readdirSync(process.env.BILI_COMMENT_LEDGER_DIR); const record=JSON.parse(fs.readFileSync(path.join(process.env.BILI_COMMENT_LEDGER_DIR,files[0]))); if(record.status!=='unknown') throw Error('not reserved before submission'); fs.appendFileSync(process.env.CALLS,'sent\\n'); if(process.env.HANG) await new Promise(()=>{});};
 globalThis.fetch=async()=>{await sent(); return {json:async()=>({code:0})}};
 let typed='',ev=0; const editor={first(){return this},async waitFor(){},async click(){},async innerText(){return typed}}; const button={first(){return this},async waitFor(){},async evaluate(){return false},async click(){await sent()}};
 const page={async goto(){},async waitForTimeout(){},async evaluate(){return ++ev===2?{aid:90123,bvid:'synthetic'}:''},locator(s){return s.startsWith('div')?editor:button},keyboard:{async type(v){typed=v}}};
 chromium.launch=async()=>({isConnected:()=>true,async close(){},async newContext(){return {async addCookies(){},async newPage(){return page},async close(){}}}});
 const headers={cookie:'DedeUserID=123; bili_jct=test'}, opts={ownerIds:['987654']};
 const r=process.env.MODE==='browser'?await browserComment('synthetic','视频里的内容真有意思',{dedeuserid:'123'},{...opts,aid:90123,typeDelay:0}):process.env.MODE==='reply'?await __debug.replyToComment(90123,33,'视频里的内容真有意思',headers,opts):await __debug.postComment(90123,'视频里的内容真有意思',headers,opts); await closeWatchBrowser(); console.log(JSON.stringify(r));`;
function child(dir,extra={}) {return spawn(process.execPath,['--input-type=module','-e',script],{env:{...process.env,HOME:dir,BILI_COMMENT_LEDGER_DIR:path.join(dir,'ledger'),CALLS:path.join(dir,'calls'),...extra},stdio:['ignore','pipe','pipe']});}
function done(p){return new Promise((resolve,reject)=>{let out='',err='';p.stdout.on('data',v=>out+=v);p.stderr.on('data',v=>err+=v);p.on('error',reject);p.on('close',code=>resolve({code,out,err}));});}
async function waitFile(file){for(let i=0;i<200;i++){if(fs.existsSync(file))return;await new Promise(r=>setTimeout(r,20));}throw Error('timed out');}
test('two processes cannot submit same target',async()=>{const dir=fs.mkdtempSync(path.join(base,'race-'));const a=child(dir),b=child(dir);const result=await Promise.all([done(a),done(b)]);assert.deepEqual(result.map(x=>x.code),[0,0],JSON.stringify(result));assert.equal(fs.readFileSync(path.join(dir,'calls'),'utf8').trim().split('\n').length,1);assert.equal(result.filter(x=>JSON.parse(x.out).ok).length,1);});
test('SIGKILL after network submission leaves durable unknown',async()=>{const dir=fs.mkdtempSync(path.join(base,'kill-'));const p=child(dir,{HANG:'1'});const pDone=done(p);await waitFile(path.join(dir,'calls'));p.kill('SIGKILL');await pDone;const r=await done(child(dir));assert.equal(JSON.parse(r.out).code,'comment_already_reserved');assert.equal(fs.readFileSync(path.join(dir,'calls'),'utf8').trim().split('\n').length,1);const record=JSON.parse(fs.readFileSync(path.join(dir,'ledger',fs.readdirSync(path.join(dir,'ledger'))[0]),'utf8'));assert.equal(record.status,'unknown');});
test('unwritable ledger fails closed before fetch',async()=>{const dir=fs.mkdtempSync(path.join(base,'bad-'));fs.writeFileSync(path.join(dir,'ledger'),'not a directory');const r=await done(child(dir));assert.equal(JSON.parse(r.out).code,'comment_ledger_unavailable');assert.equal(fs.existsSync(path.join(dir,'calls')),false);});
for (const mode of ['reply','browser']) {
 test(mode+' persists unknown before submission and blocks retry after crash',async()=>{const dir=fs.mkdtempSync(path.join(base,mode+'-'));const p=child(dir,{MODE:mode,HANG:'1'});const pDone=done(p);await waitFile(path.join(dir,'calls'));p.kill('SIGKILL');await pDone;const r=await done(child(dir,{MODE:mode}));assert.equal(r.code,0,r.err);assert.equal(JSON.parse(r.out).code,'comment_already_reserved');assert.equal(fs.readFileSync(path.join(dir,'calls'),'utf8').trim().split('\n').length,1);});
 test(mode+' refuses to submit if persistence fails',async()=>{const dir=fs.mkdtempSync(path.join(base,mode+'-bad-'));fs.writeFileSync(path.join(dir,'ledger'),'not a directory');const r=await done(child(dir,{MODE:mode}));assert.equal(r.code,0,r.err);assert.equal(JSON.parse(r.out).code,'comment_ledger_unavailable');assert.equal(fs.existsSync(path.join(dir,'calls')),false);});
}
