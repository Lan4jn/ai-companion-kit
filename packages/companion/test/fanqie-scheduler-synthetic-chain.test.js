import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {once,EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {setupProductionFanqie} from '../src/index.js';
import {startFanqieAutonomous} from '../src/fanqie-startup.js';
import {createFanqieIntegration} from '../src/fanqie-integration.js';
import {createPhoneMutex} from '../src/phone-mutex.js';

const adb = `#!/usr/bin/python3
import os,sys,json
sfile=os.environ['SYNTH_STATE']; s=json.load(open(sfile)); a=sys.argv[1:]
with open(sfile+'.log','a') as f:f.write(json.dumps(a)+'\\n')
if len(a)<3 or a[:2]!=['-s','fixture']:sys.exit(21)
a=a[2:]; cmd=' '.join(a)
if cmd=='get-state':
 print('offline' if s.get('offline') else 'device');sys.exit(0)
if s.get('offline'):sys.exit(22)
reader=s['screen'] in ['reader','catalog']
if cmd=='shell dumpsys window': print('mCurrentFocus=Window{ com.dragon.read/.'+('ReaderActivity' if reader else 'MainFragmentActivity')+'}')
elif cmd=='shell uiautomator dump /sdcard/window.xml': print('UI hierchary dumped to: /sdcard/window.xml')
elif cmd=='exec-out cat /sdcard/window.xml':
 def n(t,id='',b='[0,0][100,30]'):return '<node text="'+t+'" resource-id="'+id+'" bounds="'+b+'" package="com.dragon.read" enabled="true"/>'
 if s['screen']=='shop': print(n('书城')+n('合成星河','com.dragon.read:id/book_title','[10,100][300,140]')+n('这是合成的书籍介绍供测试使用星空旅人与森林营地之中的奇妙冒险故事没有真实来源','com.dragon.read:id/book_description','[10,150][400,210]'))
 elif s['screen']=='reader': print(n('第一章')+n('1/3')+n('目录','','[10,300][80,350]'))
 else: print(n('合成星河')+n('合成作者')+n('搜全文')+n('目录')+n('已完结'))
elif cmd=='shell input tap 155 120' and s['screen']=='shop':s['screen']='reader'
elif cmd=='shell input tap 45 325' and s['screen']=='reader':s['screen']='catalog'
elif cmd=='shell input keyevent 4' and s['screen']=='catalog':s['screen']='reader'
elif cmd=='exec-out screencap -p':sys.stdout.buffer.write(b'synthetic screenshot')
else:sys.exit(23)
json.dump(s,open(sfile,'w'))
`;
const passages=[
 '营地的橘猫在温暖的阳光下睡觉。山风吹过帐篷，孩子们在河边捡起圆圆的石头。老人端来一壶热茶，大家围坐在木桌旁，听他讲述远方森林里的故事。夜色降临他们收拾行李回到了家。',
 '营地的白狗在清晨的草地上奔跑。山风吹过帐篷，旅人沿着河岸慢慢前行。年轻的园丁种下一棵小树，大家一起浇水，期待春天开出美丽的花朵。夜色降临他们收拾行李回到了家。',
 '营地的黑鸟在寒冷的雨夜里鸣叫。山风吹过帐篷，旅人躲进狭小的木屋。窗外的雨水落在石头上，屋里只有一盏灯，照亮桌上的旧书和地图。夜色降临他们收拾行李回到了家。'
];

test('production startup and real scheduler: isolated synthetic device, OCR, decisions, restart and forgetting', {timeout:120000}, async t=>{
 const dir=await fs.mkdtemp(path.join(process.env.TMPDIR,'fanqie-scheduler-e2e-')); const bin=path.join(dir,'bin');await fs.mkdir(bin);
 const old={PATH:process.env.PATH,PHONE_SERIAL:process.env.PHONE_SERIAL,SYNTH_STATE:process.env.SYNTH_STATE,PHONE_MUTEX_PATH:process.env.PHONE_MUTEX_PATH};
 t.after(async()=>{for(const [k,v] of Object.entries(old))v===undefined?delete process.env[k]:process.env[k]=v;await fs.rm(dir,{recursive:true,force:true})});
 await fs.writeFile(path.join(bin,'adb'),adb,{mode:0o700});
 await fs.writeFile(path.join(bin,'tesseract'),`#!/usr/bin/python3\nimport os,json\ns=json.load(open(os.environ['SYNTH_STATE']));print(s['text'])\n`,{mode:0o700});
 Object.assign(process.env,{PATH:bin+':'+old.PATH,PHONE_SERIAL:'fixture',SYNTH_STATE:path.join(dir,'state.json'),PHONE_MUTEX_PATH:path.join(dir,'phone.lock')});
 const setState=async (extra={})=>fs.writeFile(process.env.SYNTH_STATE,JSON.stringify({screen:'shop',text:passages[0],...extra}));
 let interest=true,will=true,choice=1,understands=0, social=0;const inputs=[];
 const brain={complete:async ({system,prompt})=>{inputs.push({system,prompt});if(system.includes('现在是否想读'))return JSON.stringify({want:will});if(system.includes('只能从提供'))return JSON.stringify({choice});if(system.includes('阅读目标'))return '{"want":false}';if(system.includes('小说OCR原文')){understands++;return JSON.stringify({interested:interest,continueReading:false,summary:'合成摘要，不能当作原文',keywords:['营地']});}social++;return '{"action":"skip"}';}};
 let scheduler, loopDone;const loopResult=new Promise(resolve=>{loopDone=resolve});const oldLog=console.log;console.log=(...args)=>{if(args[0]==='[FanqieScheduler]'&&args[1]==='success')loopDone();else oldLog(...args)};t.after(()=>{console.log=oldLog});
 const mutex=createPhoneMutex({lockPath:process.env.PHONE_MUTEX_PATH});
 const signals=new EventEmitter();signals.exit=()=>{};
 const cfg={fanqie:{enabled:true,serial:'fixture'},dataDir:dir};
 await setState();
 let handle;setupProductionFanqie({cfg,brain,signals,start:opts=>(handle=startFanqieAutonomous({...opts,mutex,createIntegration:o=>{const x=createFanqieIntegration({...o,intervalMs:50});scheduler=x.scheduler;return x;}}))});
 t.after(()=>handle?.stop?.());assert.ok(scheduler);
 await Promise.race([loopResult,new Promise((_,reject)=>setTimeout(()=>reject(Error('scheduled loop did not complete')),30000))]);await handle.stop();console.log=oldLog;
 const rows=async()=>JSON.parse('['+(await fs.readFile(path.join(dir,'fanqie-reading.jsonl'),'utf8')).trim().split('\n').join(',')+']');
 assert.equal((await rows()).length,1);assert.equal(understands,1);
 setupProductionFanqie({cfg,brain,signals:new EventEmitter(),start:opts=>(handle=startFanqieAutonomous({...opts,mutex,createIntegration:o=>{const x=createFanqieIntegration({...o,intervalMs:3600000});scheduler=x.scheduler;return x;}}))});
 let r;
 for(let i=1;i<3;i++){interest=i<2;await setState({text:passages[i]});r=await scheduler.tick();assert.equal(r.ok,true,JSON.stringify(r));assert.equal(understands,i+1);const saved=await rows();assert.equal(saved.length,Math.min(i+1,2));}
 const initial=await rows();for(let i=0;i<2;i++){const row=initial[i];assert.equal(row.text,passages[i]);assert.notEqual(row.text,row.summary);assert.equal(row.fingerprint,createHash('sha256').update(row.text).digest('hex'));assert.deepEqual(row.progress,{chapter:'第一章',page:1,total:3});assert.equal(row.bookTitle,'合成星河');assert.match(row.source,/OCR/);}assert.equal(social,3);
 await setState();choice=0;r=await scheduler.tick();assert.equal(r.reason,'not-interested');assert.equal((await rows()).length,2);choice=1;
 will=false;await setState();r=await scheduler.tick();assert.equal(r.reason,'not-interested');assert.equal((await rows()).length,2);will=true;
 await setState({offline:true});r=await scheduler.tick();assert.equal(r.reason,'device-offline');assert.equal((await rows()).length,2);
 // A separate process holds the exact same kernel lock. The scheduler must not act.
 await setState();const url=new URL('../src/phone-mutex.js',import.meta.url).href;
 const child=spawn(process.execPath,['--input-type=module','-e',`import {createPhoneMutex} from ${JSON.stringify(url)};await createPhoneMutex({lockPath:process.argv[1]}).runUser(async()=>{console.log('ready');await new Promise(r=>process.stdin.once('data',r))});`,process.env.PHONE_MUTEX_PATH],{stdio:['pipe','pipe','pipe']});t.after(()=>child.kill());await once(child.stdout,'data');
 const before=(await fs.readFile(process.env.SYNTH_STATE+'.log','utf8')).split('\n').length;r=await scheduler.tick();assert.equal(r.reason,'busy');const after=(await fs.readFile(process.env.SYNTH_STATE+'.log','utf8')).split('\n').length;assert.equal(after,before);child.stdin.end('done');await once(child,'exit');
 const log=(await fs.readFile(process.env.SYNTH_STATE+'.log','utf8')).trim().split('\n').map(JSON.parse);assert.ok(log.length>0);assert.ok(log.every(a=>a[0]==='-s'&&a[1]==='fixture'));assert.ok(!log.some(a=>a.includes('swipe')));
 // The owner chat, authorization and ledger run in a fresh Node process.
 const chatUrl=new URL('../src/index.js',import.meta.url).href, memoryUrl=new URL('../src/memory-brain-trust.js',import.meta.url).href, msgUrl=new URL('./tieba-trusted-message-fixture.js',import.meta.url).href;
 const code=`import {handleTurn} from ${JSON.stringify(chatUrl)};import {initializeManagedStore,createManagedMemoryBrain} from ${JSON.stringify(memoryUrl)};import {tiebaMessage} from ${JSON.stringify(msgUrl)};import path from 'node:path';const dir=process.argv[1],rows=JSON.parse(process.argv[2]);const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'};const directory=path.join(dir,'memory-brain-scoped');initializeManagedStore(directory);const cfg={ownerIds:['1'],dataDir:dir,memoryBrain:{enabled:true,backend:'sqlite-fts',trustedProcess:true,trustedScope:scope,authorizedSources:['fanqie-ocr']}};const store=createManagedMemoryBrain({directory,scope,sources:['fanqie-ocr'],trustedProcess:true,backend:'sqlite-fts'});const prompts=[];const deps={brain:{reply:async p=>{prompts.push(p);return {text:''}}},memory:{dir},bot:{},human:{},waker:{}};async function chat(options){await handleTurn(deps,[await tiebaMessage({text:'最近读了什么小说，营地怎么样',...options})],cfg);return prompts.at(-1).situation}const out=[];out.push(await chat({id:201}));await store.forget(scope,{source:'fanqie-ocr',evidence:'sha256:'+rows[0].fingerprint});out.push(await chat({id:202}));out.push(await chat({id:203,userId:2}));out.push(await chat({id:204,userId:1,type:'group',groupId:55}));await store.forget(scope,{source:'fanqie-ocr',evidence:'sha256:'+rows[1].fingerprint});out.push(await chat({id:205}));console.log('RESULT:'+JSON.stringify(out));`;
 const out=execFileSync(process.execPath,['--input-type=module','-e',code,dir,JSON.stringify(initial)],{encoding:'utf8',timeout:30000});const line=out.split('\n').find(x=>x.startsWith('RESULT:'));assert.ok(line,out);const prompts=JSON.parse(line.slice(7));
 for(const row of initial)assert.ok(prompts[0].includes(JSON.stringify(row.text)));assert.ok(!prompts[1].includes(JSON.stringify(initial[0].text)));assert.ok(prompts[1].includes(JSON.stringify(initial[1].text)));for(const p of prompts.slice(2))for(const row of initial)assert.ok(!p.includes(JSON.stringify(row.text)));
 await scheduler.stop();
});
