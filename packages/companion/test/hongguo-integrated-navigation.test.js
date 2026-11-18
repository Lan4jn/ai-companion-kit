import test from 'node:test';
import assert from 'node:assert/strict';
import { createHongguoIntegration } from '../src/hongguo-integration.js';
import { recallHongguo } from '../src/hongguo-memory.js';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
test('integration uses observed cards and honors Brain choice to skip without tapping', async () => {
 const old=process.env.PHONE_SERIAL;process.env.PHONE_SERIAL='emulator-5554';let taps=0,decisions=0;
 try {
 const xml='<hierarchy><node class="androidx.compose.ui.platform.ComposeView"><node class="android.view.View" clickable="true" enabled="true" bounds="[10,20][210,320]"><node><node class="android.widget.TextView" text="真实剧名" bounds="[20,30][150,70]" /></node></node></node></hierarchy>';
 const run=async (_c,args)=>{let a=args.slice(2).join(' ');if(a==='shell dumpsys media_session')return {stdout:''};if(a==='shell dumpsys activity activities')return {stdout:'mResumedActivity: ActivityRecord{a u0 com.example.drama/.Main t1}'};if(a==='shell uiautomator dump /sdcard/_hongguo_ui.xml')return {stdout:'ok'};if(a==='shell cat /sdcard/_hongguo_ui.xml')return {stdout:xml};if(a.startsWith('shell input tap ')){taps++;return {stdout:''}};throw Error(a)};
 const integration=createHongguoIntegration({enabled:true,serial:process.env.PHONE_SERIAL,packageName:'com.example.drama',run,mutex:{tryBackground:async fn=>{await fn();return true}}});
 const prompts=[];
 const result=await integration.tick({permission:true,brain:{complete:async({prompt})=>{prompts.push(prompt);return ++decisions===1?'{"want":false}':'{"index":null}'}}});
 assert.equal(result.status,'skipped');assert.equal(decisions,1);assert.equal(taps,0);
 assert.match(prompts[0],/真实剧名/);
 } finally {if(old===undefined)delete process.env.PHONE_SERIAL;else process.env.PHONE_SERIAL=old;}
});


test('selected card verified by screen progress saves recallable viewing memory', async t => {
 const old=process.env.PHONE_SERIAL; process.env.PHONE_SERIAL='emulator-5554';
 const dir=await mkdtemp(path.join(process.env.TMPDIR,'hongguo-selected-'));
 t.after(async()=>{if(old===undefined)delete process.env.PHONE_SERIAL;else process.env.PHONE_SERIAL=old;await rm(dir,{recursive:true,force:true})});
 const title='真实剧名长长长长长长长';
 const xml=`<hierarchy><node class="androidx.compose.ui.platform.ComposeView"><node class="android.view.View" clickable="true" enabled="true" bounds="[10,20][210,320]"><node><node class="android.widget.TextView" text="${title}" bounds="[20,30][150,70]" /></node></node></node></hierarchy>`;
 const images=[300,340].map(x=>execFileSync('convert',['-size','1920x1080','xc:black','-fill','white','-draw',`rectangle ${x},978 ${x+4},982`,'png:-']));
 const catalogueImage=execFileSync('convert',['-size','1920x1080','xc:black','png:-']);
 let taps=0,shots=0,clock=0,decisions=0;
 const run=async (_c,args)=>{const a=args.slice(2).join(' ');if(a==='shell dumpsys activity activities')return {stdout:'mResumedActivity: ActivityRecord{a u0 com.example.drama/.Main t1}'};if(a==='shell dumpsys media_session')return {stdout:''};if(a==='shell uiautomator dump /sdcard/_hongguo_ui.xml')return {stdout:'ok'};if(a==='shell cat /sdcard/_hongguo_ui.xml')return {stdout:xml};if(a.startsWith('shell input tap ')){taps++;return {stdout:''}};if(a==='exec-out screencap -p')return {stdout:taps ? images[shots++] : catalogueImage};throw Error(a)};
 const integration=createHongguoIntegration({enabled:true,serial:process.env.PHONE_SERIAL,packageName:'com.example.drama',run,mutex:{tryBackground:async fn=>{await fn();return true}},memoryDir:dir,now:()=>++clock,recognize:async()=>[`${title} >`,'第1集','车站再见'],wait:async()=>{}});
 const brain={complete:async()=>['{"want":true}','{"index":0}','{"interested":true,"summary":"屏幕文字提到车站再见","keywords":["车站"]}'][decisions++]};
 const result=await integration.tick({permission:true,brain});
 assert.equal(result.status,'verified');assert.equal(result.memory.status,'saved');assert.equal(taps,1);assert.equal(shots,2);
 const records=await recallHongguo(dir,'车站');assert.equal(records.length,1);assert.equal(records[0].episodeId,`${title}:第1集`);assert.ok(Number.isFinite(records[0].progress.fraction));assert.equal(records[0].audio,null);
});
