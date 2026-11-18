import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startFanqieAutonomous } from '../src/fanqie-startup.js';

test('first willingness receives fresh candidates acquired under shared mutex and can refuse', async t => {
 const dir=await fs.mkdtemp(path.join(process.env.TMPDIR,'fq-live-')); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const old=process.env.PHONE_SERIAL; process.env.PHONE_SERIAL='fixture'; t.after(()=>{if(old===undefined)delete process.env.PHONE_SERIAL;else process.env.PHONE_SERIAL=old});
 let locked=false,prompt,want;
 const mutex={tryBackground:async fn=>{locked=true;try{await fn();return true}finally{locked=false}}};
 const handle=startFanqieAutonomous({enabled:true,serial:'fixture',dataDir:dir,mutex,observeCandidates:async()=>{assert.equal(locked,true);return {ok:true,observedAt:new Date().toISOString(),candidates:[{title:'星海书',description:'一段来自当前屏幕的简介'}]}},brain:{complete:async r=>{assert.equal(locked,false);prompt=r.prompt;return '{"want":false}'}},createIntegration:o=>{want=o.want;return {scheduler:{start(){},stop(){}}}}}); t.after(()=>handle.stop());
 assert.equal(await want(),false); assert.match(prompt,/星海书/); assert.match(prompt,/采集时间/); assert.match(prompt,/可能已经过期/); assert.match(prompt,/没有可用的已保存阅读观察/);
});

test('unavailable phone is explicit rather than invented and preserves history', async t => {
 const dir=await fs.mkdtemp(path.join(process.env.TMPDIR,'fq-live-')); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 await fs.writeFile(path.join(dir,'fanqie-reading.jsonl'),JSON.stringify({source:'OCR',text:'历史内容'})+'\n');
 const old=process.env.PHONE_SERIAL; process.env.PHONE_SERIAL='fixture'; t.after(()=>{if(old===undefined)delete process.env.PHONE_SERIAL;else process.env.PHONE_SERIAL=old});
 let prompt,want,called=false;
 const handle=startFanqieAutonomous({enabled:true,serial:'fixture',dataDir:dir,historyFilter:async rows=>rows,mutex:{tryBackground:async()=>false},observeCandidates:async()=>{called=true},brain:{complete:async r=>{prompt=r.prompt;return '{"want":true}'}},createIntegration:o=>{want=o.want;return {scheduler:{start(){},stop(){}}}}}); t.after(()=>handle.stop());
 assert.equal(await want(),true); assert.equal(called,false); assert.match(prompt,/实时.*不可用/); assert.match(prompt,/历史内容/); assert.match(prompt,/不要.*编造/);
});


test('stale observations never enter prompt as current candidates',async t=>{
 const old=process.env.PHONE_SERIAL;process.env.PHONE_SERIAL='fixture';t.after(()=>{if(old===undefined)delete process.env.PHONE_SERIAL;else process.env.PHONE_SERIAL=old});
 let want,prompt;const handle=startFanqieAutonomous({enabled:true,serial:'fixture',dataDir:process.env.TMPDIR,context:async()=>'',mutex:{tryBackground:async fn=>{await fn();return true}},observeCandidates:async()=>({ok:true,observedAt:'2000-01-01T00:00:00.000Z',candidates:[{title:'STALE_BOOK',description:'old'}]}),brain:{complete:async r=>{prompt=r.prompt;return '{"want":false}'}},createIntegration:o=>{want=o.want;return {scheduler:{start(){},stop(){}}}}});t.after(()=>handle.stop());
 await want();assert.doesNotMatch(prompt,/STALE_BOOK/);assert.match(prompt,/过期/);
});
