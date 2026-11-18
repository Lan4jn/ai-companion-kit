import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {browseWebTopic, renderWebKnowledge, createWebScope} from '../src/web-living.js';
import {initializeManagedStore} from '../src/memory-brain-trust.js';
import {createGoalCore} from '../src/goal-core.js';

test('concurrent requests claim normalized topic before any search', async t => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'web-claim-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let calls=0, release, entered; const gate=new Promise(r=>entered=r);
 const search=async()=>{calls++; if (calls > 1) return {success:false}; entered(); await new Promise(r=>release=r); return {success:false};};
 const brain={complete:async()=>({deep:true})};
 const first=browseWebTopic({topic:'Steam游戏',memory:{dir},brain,search}); await gate;
 const second=await browseWebTopic({topic:'steam 游戏',memory:{dir},brain,search});
 assert.equal(calls,1); assert.equal(second.goalStatus,'unknown'); release(); await first;
});

test('old active unknown is never timed out into retry', async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'web-old-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const core=createGoalCore({file:path.join(dir,'web-goals.json')});
 core.ensureGoalDesire({goal:{id:'old',title:JSON.stringify({kind:'web-deep-search',topic:'Steam游戏',startedAt:1}),target:1},desire:{id:'old',title:'test',goalId:'old'}});
 let calls=0; const result=await browseWebTopic({topic:'steam 游戏',memory:{dir},brain:{complete:async()=>({})},search:async()=>{calls++; return {success:false};}});
 assert.equal(calls,0); assert.equal(result.goalStatus,'unknown'); assert.equal(core.snapshot().desires.old.status,'active');
});

test('two independent processes share one durable normalized-topic claim through completed source evidence', async t => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'web-process-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const script = `import fs from 'node:fs'; import path from 'node:path'; import {browseWebTopic} from './src/web-living.js';
 const dir=process.argv[1], topic=process.argv[2], quote='Steam游戏包含一个公开测试内容'; let searches=0;
 const search=async()=>{searches++; if(searches===1){fs.appendFileSync(path.join(dir,'calls'),'x'); process.stdout.write('ENTERED\\n'); while(!fs.existsSync(path.join(dir,'release'))) await new Promise(r=>setTimeout(r,10));} return {success:true,text:'1. Steam游戏相关介绍\\n(来源: web https://example.com/a)'};};
 const brain={complete:async({prompt})=>prompt.includes('想不想再花')?{deep:true}:prompt.includes('页面证据')?{relevant:true,quote}:prompt.includes('是否想把这段原文')?{interested:false}:{details:'摘要',mood:'看看'}};
 const result=await browseWebTopic({topic,memory:{dir},brain,search,readEvidence:async()=>({url:'https://example.com/a',text:quote})}); process.stdout.write('RESULT '+JSON.stringify(result)+'\\n');`;
 const run=topic=>spawn(process.execPath,['--input-type=module','-e',script,dir,topic],{cwd:process.cwd(),env:process.env});
 const first=run('Steam游戏'); t.after(()=>first.kill());
 let firstOut=''; await new Promise((resolve,reject)=>{first.stdout.on('data',c=>{firstOut+=c; if(firstOut.includes('ENTERED')) resolve();}); first.on('error',reject); first.on('exit',code=>{if(!firstOut.includes('ENTERED')) reject(new Error('first exited '+code+' '+firstOut));});});
 const second=run('steam 游戏'); let out=''; second.stdout.on('data',c=>out+=c); const code=await new Promise(r=>second.on('exit',r));
 assert.equal(code,0); assert.match(out, /"goalStatus":"unknown"/); assert.equal(fs.readFileSync(path.join(dir,'calls'),'utf8'),'x');
 fs.writeFileSync(path.join(dir,'release'),''); assert.equal(await new Promise(r=>first.on('exit',r)),0);
 assert.match(firstOut,/"goalStatus":"completed"/); assert.match(firstOut,/"success":true/);
 const snap=createGoalCore({file:path.join(dir,'web-goals.json')}).snapshot();
 assert.equal(Object.keys(snap.desires).length,1); const desire=Object.values(snap.desires)[0]; assert.equal(desire.status,'completed');
 const event=snap.events[desire.outcomeEventId]; assert.equal(event.type,'desire.completed'); const evidence=JSON.parse(fs.readFileSync(event.evidence.ref)); assert.equal(evidence.quote,'Steam游戏包含一个公开测试内容'); assert.equal(event.evidence.source,'web-source-page'); assert.equal(event.evidence.sha256,createHash('sha256').update(fs.readFileSync(event.evidence.ref)).digest('hex')); assert.equal(event.desireId,desire.id);
});

test('independent data scopes neither block nor reveal one another', async t=>{
 const root=fs.mkdtempSync(path.join(process.env.TMPDIR,'web-scope-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const a=path.join(root,'a'),b=path.join(root,'b'),topic='Steam游戏',quote='Steam游戏包含一个公开测试内容';
 let release, entered; const gate=new Promise(r=>entered=r);
 const pending=browseWebTopic({topic,memory:{dir:a},brain:{complete:async()=>({})},search:async()=>{entered();await new Promise(r=>release=r);return {success:false}}});
 await gate;
 const search=async()=>({success:true,text:'1. Steam游戏相关介绍\n(来源: web https://example.com/a)'});
 const brain={complete:async({prompt})=>prompt.includes('想不想再花')?{deep:true}:prompt.includes('页面证据')?{relevant:true,quote}:prompt.includes('是否想把这段原文')?{interested:true}:{details:'摘要',mood:'看看'}};
 const result=await browseWebTopic({topic,memory:{dir:b},search,brain,readEvidence:async()=>({url:'https://example.com/a',text:quote})});
 assert.equal(result.goalStatus,'completed'); assert.match(renderWebKnowledge(b),/Steam游戏包含/); assert.equal(renderWebKnowledge(a),'');
 const sa=createGoalCore({file:path.join(a,'web-goals.json')}).snapshot(), sb=createGoalCore({file:path.join(b,'web-goals.json')}).snapshot();
 assert.equal(Object.values(sa.desires)[0].status,'active'); assert.equal(Object.values(sb.desires)[0].status,'completed');
 assert.ok(!JSON.stringify(sa).includes(quote)); release(); assert.equal((await pending).goalStatus,'unknown');
});

test('claim store read failure starts neither search nor model', async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'web-fail-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 fs.mkdirSync(path.join(dir,'web-goals.json')); let searches=0, models=0;
 const result=await browseWebTopic({topic:'Steam游戏',memory:{dir},search:async()=>{searches++},brain:{complete:async()=>{models++}}});
 assert.equal(result.goalStatus,'unknown'); assert.equal(result.success,false); assert.equal(searches,0); assert.equal(models,0);
 assert.equal(fs.readdirSync(path.join(dir,'web-goals.json')).length,0);
});

test('atomic claim rename failure starts neither search nor model', async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'web-write-fail-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const preload=path.join(dir,'deny-rename.cjs');
 fs.writeFileSync(preload,`const fs=require('node:fs'); const original=fs.renameSync; fs.renameSync=(a,b)=>{if(String(b).endsWith('/web-goals.json')) throw Object.assign(new Error('simulated EIO'),{code:'EIO'}); return original(a,b)};`);
 const script=`import assert from 'node:assert/strict'; import {browseWebTopic} from './src/web-living.js'; let searches=0,models=0; const r=await browseWebTopic({topic:'Steam游戏',memory:{dir:process.argv[1]},search:async()=>{searches++},brain:{complete:async()=>{models++}}}); assert.equal(r.goalStatus,'unknown'); assert.equal(r.success,false); assert.equal(searches,0); assert.equal(models,0);`;
 const {spawnSync}=await import('node:child_process'); const child=spawnSync(process.execPath,['--input-type=module','-e',script,dir],{cwd:process.cwd(),env:{...process.env,NODE_OPTIONS:`--require=${preload}`},encoding:'utf8'});
 assert.equal(child.status,0,child.stderr); assert.equal(fs.existsSync(path.join(dir,'web-goals.json')),false); assert.deepEqual(fs.readdirSync(dir).sort(),['deny-rename.cjs','web-goals.json.lock']);
});

test('definite failure permits a fresh attempt while unknown never does', async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'web-retry-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let searches=0; const search=async()=>{searches++; return {success:true,text:'1. Steam游戏相关介绍\n(来源: web https://example.com/a)'}};
 const brain={complete:async({prompt})=>prompt.includes('想不想再花')?{deep:false}:{details:'摘要',mood:'看看'}};
 assert.equal((await browseWebTopic({topic:'Steam游戏',memory:{dir},search,brain})).goalStatus,'failed');
 assert.equal((await browseWebTopic({topic:'steam 游戏',memory:{dir},search,brain})).goalStatus,'failed'); assert.equal(searches,2);
 const unknown=await browseWebTopic({topic:'Steam游戏',memory:{dir},search:async()=>{searches++; throw Error('timeout')},brain}); assert.equal(unknown.goalStatus,'unknown');
 const blocked=await browseWebTopic({topic:'steam 游戏',memory:{dir},search,brain}); assert.equal(blocked.goalStatus,'unknown'); assert.equal(searches,3);
});

// Different identities intentionally share one directory and one normalized topic.
test('same directory concurrent owners do not block each other research claims',async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'web-same-dir-scope-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let release,entered; const gate=new Promise(r=>entered=r); let secondCalls=0;
 initializeManagedStore(path.join(dir,'memory-brain-scoped'));
 const scope=user=>createWebScope({dataDir:dir,ownerIds:[user],memoryBrain:{enabled:true,trustedProcess:true,trustedScope:{tenant:'companion',platform:'qq',type:'private',session:`private:${user}`,user},authorizedSources:['web-source-page']}},dir);
 const first=browseWebTopic({topic:'Steam游戏',webScope:scope('1'),memory:{dir},brain:{complete:async()=>({})},search:async()=>{entered();await new Promise(r=>release=r);return {success:false}}});
 await gate;
 try {
  await browseWebTopic({topic:'steam 游戏',webScope:scope('2'),memory:{dir},brain:{complete:async()=>({})},search:async()=>{secondCalls++;return {success:false}}});
  assert.equal(secondCalls,1,'distinct owners must not share a claim');
 } finally { release(); await first; }
});
