import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createFanqieIntegration } from '../src/fanqie-integration.js';
import { startFanqieAutonomous } from '../src/fanqie-startup.js';

test('startup suppresses stored reading evidence without an authorized filter', async t => {
 const dir=await fs.mkdtemp(path.join(process.env.TMPDIR,'fq-context-')); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 await fs.writeFile(path.join(dir,'fanqie-reading.jsonl'),JSON.stringify({source:'屏幕OCR（可能有误）',bookTitle:'已确认的书',text:'古城营地升起篝火',summary:'一群人在营地',at:'2026-01-01T00:00:00Z'})+'\n');
 const old=process.env.PHONE_SERIAL; process.env.PHONE_SERIAL='fixture'; t.after(()=>{if(old===undefined)delete process.env.PHONE_SERIAL;else process.env.PHONE_SERIAL=old});
 let prompt,want; const handle=startFanqieAutonomous({enabled:true,serial:'fixture',dataDir:dir,brain:{complete:async r=>{prompt=r.prompt;return '{"want":false}'}},createIntegration:o=>{want=o.want;return {scheduler:{start(){},stop(){}}}}}); t.after(()=>handle.stop());
 assert.equal(await want(),false); assert.doesNotMatch(prompt,/古城营地升起篝火|已确认的书/);
});

test('goal decision gets the verified observed page, before saving it', async t => {
 const dir=await fs.mkdtemp(path.join(process.env.TMPDIR,'fq-goal-context-')); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 let goalPrompt; const text='真实正文古城营地升起篝火'.repeat(8);
 const brain={complete:async r=>{if(r.system.includes('阅读目标')){goalPrompt=r.prompt;return '{"want":false}'} if(r.system.includes('OCR原文'))return '{"interested":true,"continueReading":false,"summary":"营地","keywords":[]}'; return '{"action":"none"}';}};
 const integration=createFanqieIntegration({serial:'fixture',brain,memoryDir:dir,want:async()=>true,goalCore:{},mutex:{tryBackground:async fn=>{await fn();return true}},online:async()=>true,navigate:async()=>({ok:true,bookTitle:'确认的书'}),progress:async()=>({chapter:'第一章',page:1,total:5}),capture:async()=>({text,source:'屏幕OCR（可能有误）',fingerprint:'fixture'}),save:async()=>{}});
 assert.equal((await integration.run()).ok,true); assert.match(goalPrompt,/真实正文古城营地/); assert.match(goalPrompt,/第一章/); assert.match(goalPrompt,/屏幕OCR/);
});
