import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const moduleUrl = new URL('../src/group-bridge.js', import.meta.url).href;
const delay = ms => new Promise(r=>setTimeout(r,ms));
async function waitFor(f) { for(let i=0;i<200;i++){if(fs.existsSync(f))return; await delay(10);} throw Error('timed out: '+f); }
function child(dir, mode) {
 const source = `import fs from 'node:fs'; import {initGroupBridge,enqueueGroupMessage,startOutboxWorker,stopOutboxWorker,sendTurnGroupMessage} from ${JSON.stringify(moduleUrl)};
const d=process.env.FIXTURE; const bot={groupMembers:new Map([['1',[]],['2',[]]]),send:async(k,m)=>{fs.appendFileSync(d+'/sends',k+'\\n'); fs.writeFileSync(d+'/entered','1'); if(process.env.MODE==='fail-after') fs.mkdirSync(d+'/outbox.json.tmp'); while(process.env.MODE==='worker' && !fs.existsSync(d+'/release')) await new Promise(r=>setTimeout(r,10)); return {ok:true}}};
initGroupBridge({bot,dataDir:d,limits:{allowedGroups:['1','2'],minGapMs:0,maxGapMs:0,dailyPerGroup:1,maxPerCommand:20}});
if(process.env.MODE==='worker' || process.env.MODE==='fail-after'){startOutboxWorker(); await new Promise(r=>setTimeout(r,500)); await stopOutboxWorker();}
if(process.env.MODE==='enqueue') console.log(JSON.stringify(enqueueGroupMessage({groupId:'1',text:'hello'})));
if(process.env.MODE==='sync') console.log(JSON.stringify(await sendTurnGroupMessage({bot,identity:'unique',groupId:'2',text:'world',dispatch:async f=>f()})));
`;
 const p=spawn(process.execPath,['--input-type=module','-e',source],{env:{PATH:process.env.PATH,FIXTURE:dir,MODE:mode},stdio:['ignore','pipe','pipe']}); let out='',err=''; p.stdout.on('data',x=>out+=x);p.stderr.on('data',x=>err+=x);p.done=new Promise((resolve,reject)=>{p.on('error',reject);p.on('exit',(code,signal)=>resolve({code,signal,out,err}));});return p;
}
test('worker and synchronous path share a cross-process lock',async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'bridge-race-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let p=child(dir,'enqueue');assert.equal((await p.done).code,0);
 const worker=child(dir,'worker');t.after(()=>worker.kill('SIGKILL'));await waitFor(dir+'/entered');
 const sync=child(dir,'sync');const result=await sync.done;assert.equal(result.code,0);assert.match(result.out,/denied|unknown/);
 fs.writeFileSync(dir+'/release','1');await worker.done;
 assert.equal(fs.readFileSync(dir+'/sends','utf8').trim().split('\n').length,1);
});

test('killed worker leaves lock and inflight barrier; no automatic resend',async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'bridge-kill-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 assert.equal((await child(dir,'enqueue').done).code,0);
 const worker=child(dir,'worker'); t.after(()=>worker.kill('SIGKILL')); await waitFor(dir+'/entered');
 worker.kill('SIGKILL'); assert.equal((await worker.done).signal,'SIGKILL');
 assert.equal(JSON.parse(fs.readFileSync(dir+'/outbox.json')).pending[0].deliveryState,'inflight');
 assert.ok(fs.existsSync(dir+'/turn-group.lock'));
 assert.match((await child(dir,'sync').done).out,/denied/);
 assert.match((await child(dir,'enqueue').done).out,/error/);
 assert.equal((await child(dir,'worker').done).code,0);
 assert.equal(fs.readFileSync(dir+'/sends','utf8').trim().split('\n').length,1);
});

test('storage write failure prevents sending',async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'bridge-fail-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 assert.equal((await child(dir,'enqueue').done).code,0);
 fs.mkdirSync(dir+'/outbox.json.tmp');
 assert.equal((await child(dir,'worker').done).code,0);
 assert.equal(fs.existsSync(dir+'/sends'),false);
});

test('post-send persistent failure leaves unknown barrier across restart',async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'bridge-postfail-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 assert.equal((await child(dir,'enqueue').done).code,0);
 assert.equal((await child(dir,'fail-after').done).code,0);
 assert.equal(JSON.parse(fs.readFileSync(dir+'/outbox.json')).pending[0].deliveryState,'inflight');
 fs.rmdirSync(dir+'/outbox.json.tmp');
 assert.equal((await child(dir,'worker').done).code,0);
 assert.equal(fs.readFileSync(dir+'/sends','utf8').trim().split('\n').length,1);
});
