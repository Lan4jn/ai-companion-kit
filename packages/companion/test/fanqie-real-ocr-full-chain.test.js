import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createFanqieIntegration} from '../src/fanqie-integration.js';
import {createFanqieBackgroundFilter} from '../src/fanqie-startup.js';
import {createPhoneMutex} from '../src/phone-mutex.js';
import {handleTurn} from '../src/index.js';
import {tiebaMessage} from './tieba-trusted-message-fixture.js';
import {initializeManagedStore,createManagedMemoryBrain} from '../src/memory-brain-trust.js';

test('simulated device: real OCR -> selective reading -> restart -> authorized chat and scoped forgetting', async t => {
 const dir=await fs.mkdtemp(path.join(process.env.TMPDIR,'fanqie-full-'));
 const old={PATH:process.env.PATH,PHONE_SERIAL:process.env.PHONE_SERIAL,FIXTURE:process.env.FIXTURE};
 t.after(async()=>{for(const [k,v] of Object.entries(old)) if(v===undefined)delete process.env[k];else process.env[k]=v; await fs.rm(dir,{recursive:true,force:true})});
 const bin=path.join(dir,'bin');await fs.mkdir(bin); await fs.writeFile(path.join(bin,'package.json'),'{"type":"module"}');
 // Only the synthetic executable is reachable as adb; all unexpected commands fail closed.
 await fs.writeFile(path.join(bin,'adb'),`#!/usr/bin/node\nimport fs from 'node:fs';const a=process.argv.slice(2);if(a[0]!=='-s'||a[1]!=='fixture')process.exit(8);const cmd=a.slice(2).join(' ');fs.appendFileSync(process.env.FIXTURE+'.log',cmd+'\\n');if(cmd==='get-state')console.log('device');else if(cmd==='shell dumpsys window')console.log('mCurrentFocus=Window{ com.dragon.read/.ReaderActivity}');else if(cmd==='shell uiautomator dump /sdcard/window.xml')console.log('UI hierchary dumped to: /sdcard/window.xml');else if(cmd==='exec-out cat /sdcard/window.xml')console.log('<node text="第一章"/><node text="1/3"/>');else if(cmd==='exec-out screencap -p')process.stdout.write(fs.readFileSync(process.env.FIXTURE));else process.exit(9);\n`,{mode:0o700});
 process.env.PATH=bin+':'+old.PATH;process.env.PHONE_SERIAL='fixture';
 const passages=[
  '营地的橘猫在温暖的阳光下睡觉。山风吹过帐篷，孩子们在河边捡起圆圆的石头。老人端来一壶热茶，大家围坐在木桌旁，听他讲述远方森林里的故事。',
  '营地的白狗在清晨的草地上奔跑。山风吹过帐篷，旅人沿着河岸慢慢前行。年轻的园丁种下一棵小树，大家一起浇水，期待春天开出美丽的花朵。',
  '营地的黑鸟在寒冷的雨夜里鸣叫。山风吹过帐篷，旅人躲进狭小的木屋。窗外的雨水落在石头上，屋里只有一盏灯，照亮桌上的旧书和地图。'
 ];
 const rows=[];
 for(let i=0;i<3;i++){
  const image=path.join(dir,`page${i}.png`);
  const script=`from PIL import Image,ImageDraw,ImageFont\nimport sys,textwrap\nim=Image.new('RGB',(1200,1000),'white'); d=ImageDraw.Draw(im); f=ImageFont.truetype('/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc',42)\nfor i,s in enumerate(textwrap.wrap(sys.argv[2],24)): d.text((35,40+i*100),s,font=f,fill='black')\nim.save(sys.argv[1])`;
  execFileSync('python3',['-c',script,image,passages[i]+'夜色渐渐降临，他们收拾好行李，沿着小路回到明亮温暖的家。']);process.env.FIXTURE=image; assert.equal(execFileSync(path.join(bin,'adb'),['-s','fixture','get-state'],{encoding:'utf8'}).trim(),'device');
  let decisionPrompt='';let choices=0;
  const brain={complete:async ({system,prompt})=>{
   if(system.includes('小说OCR原文')){decisionPrompt=prompt;choices++;return JSON.stringify({interested:i!==2,continueReading:false,summary:i===0?'橘猫在营地':i===1?'白狗在营地':'黑鸟在营地',keywords:['营地']});}
   return JSON.stringify({action:'skip'});
  }};
  const x=createFanqieIntegration({serial:'fixture',brain,memoryDir:dir,want:async()=>true,mutex:createPhoneMutex({lockPath:path.join(dir,'phone.lock')}),navigate:async()=>({ok:true,bookTitle:'合成测试书'}),gesture:async()=>{throw Error('must not turn')}});
  const result=await x.run();assert.equal(result.ok,true,JSON.stringify(result)+' '+await fs.readFile(image+'.log','utf8').catch(()=>'<no adb>'));assert.equal(choices,1);assert.match(decisionPrompt,/营地/);
  const content=await fs.readFile(path.join(dir,'fanqie-reading.jsonl'),'utf8');rows.splice(0,rows.length,...content.trim().split('\n').map(JSON.parse));assert.equal(rows.length,Math.min(i+1,2));
  if(i<2){const r=rows.at(-1);assert.ok(decisionPrompt.includes(r.text));assert.equal(r.fingerprint,createHash('sha256').update(r.text).digest('hex'));assert.equal(r.progress.page,1);assert.match(r.source,/OCR/);assert.equal(r.bookTitle,'合成测试书');}
 }
 // A genuinely separate Node process reads the file from disk, not the in-memory writer.
 const moduleUrl=new URL('../src/fanqie-session.js',import.meta.url).href;
 const fromNewProcess=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',`import {recallFanqie} from ${JSON.stringify(moduleUrl)};console.log(JSON.stringify(await recallFanqie(process.argv[1],'营地',{limit:10})))`,dir],{encoding:'utf8'}));
 assert.equal(fromNewProcess.length,2);assert.deepEqual(new Set(fromNewProcess.map(r=>r.fingerprint)),new Set(rows.map(r=>r.fingerprint)));
 const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'};
 const directory=path.join(dir,'memory-brain-scoped');initializeManagedStore(directory);
 const cfg={ownerIds:['1'],dataDir:dir,memoryBrain:{enabled:true,backend:'sqlite-fts',trustedProcess:true,trustedScope:scope,authorizedSources:['fanqie-ocr']}};
 const store=createManagedMemoryBrain({directory,scope,sources:['fanqie-ocr'],trustedProcess:true,backend:'sqlite-fts'});
 const prompts=[];const deps={brain:{reply:async p=>{prompts.push(p);return {text:''}}},memory:{dir},bot:{},human:{},waker:{}};
 const chat=async options=>{await handleTurn(deps,[await tiebaMessage({text:'最近读了什么小说，营地怎么样',...options})],cfg);return prompts.at(-1).situation};
 let p=await chat({id:201});for(const r of rows)assert.ok(p.includes(JSON.stringify(r.text)));
 await store.forget(scope,{source:'fanqie-ocr',evidence:'sha256:'+rows[0].fingerprint});
 const filtered=await createFanqieBackgroundFilter(cfg,dir)(fromNewProcess);assert.deepEqual(filtered.map(r=>r.fingerprint),[rows[1].fingerprint]);
 const otherScope={...scope,session:'private:2',user:'2'};
 const other=createManagedMemoryBrain({directory,scope:otherScope,sources:['fanqie-ocr'],trustedProcess:true,backend:'sqlite-fts'});
 const candidates=rows.map(r=>({source:'fanqie-ocr',evidence:'sha256:'+r.fingerprint,text:r.text}));
 assert.equal((await other.rankCandidates(otherScope,{query:'营地',candidates})).length,2);
 p=await chat({id:202});assert.ok(!p.includes(JSON.stringify(rows[0].text)));assert.ok(p.includes(JSON.stringify(rows[1].text)));
 for(const options of [{userId:2,id:203},{userId:1,type:'group',groupId:55,id:204}]){p=await chat(options);for(const r of rows)assert.ok(!p.includes(JSON.stringify(r.text)));}
 await store.forget(scope,{source:'fanqie-ocr',evidence:'sha256:'+rows[1].fingerprint});
 p=await chat({id:205});for(const r of rows)assert.ok(!p.includes(JSON.stringify(r.text)));
});
