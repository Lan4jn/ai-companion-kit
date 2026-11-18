import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Memory } from '../src/memory.js';
import { Brain } from '../src/brain.js';
import { generateDailyDiary } from '../src/diary-system.js';
import { startProactive, stopProactive } from '../src/proactive.js';
import { spawnSync } from 'node:child_process';

test('real proactive and diary entrypoints never expose unrelated unscoped records to model', async t => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'proactive-scope-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const memory=new Memory({dir});
 const secrets=['syntheticPrivateSecret','syntheticGroupSecret','syntheticOtherSecret','syntheticDiarySecret','syntheticPersonSecret'];
 for (const [where,text] of [['private:123',secrets[0]],['group:4',secrets[1]],['private:456',secrets[2]]]) memory.logTurn({where,who:'x',text,reply:'ok'});
 memory.logDiary({activity:secrets[3]}); memory.remember('system',{fact:secrets[4]});
 let prompts=[]; t.mock.method(globalThis,'fetch',async (_url,options)=>{const req=JSON.parse(options.body); prompts.push(JSON.stringify(req.messages)); return {ok:true,text:async()=>JSON.stringify({choices:[{message:{content:'{"want":false}'}}]})};});
 const brain=new Brain({apiKey:'fake',baseUrl:'https://invalid.example',model:'fake',memory,dataDir:dir,role:{build:({situation,memory,recent})=>[situation,memory,recent].join('\n')}});
 await generateDailyDiary({brain,dataDir:dir,force:true});
 startProactive({brain,memory,bot:{send:()=>{throw Error('unexpected');}},ownerId:'123',initialDelayMs:0,minGapMs:1,activeStart:0,activeEnd:0});
 await new Promise(resolve=>setTimeout(resolve,100)); await stopProactive();
 assert.equal(prompts.length,2);
 for(const prompt of prompts) for(const secret of secrets) assert.ok(!prompt.includes(secret));
});

test('standalone diary CLI does not import shared conversation and diary text', t => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'diary-cli-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const secret='syntheticCliSecret';
 fs.writeFileSync(path.join(dir,'turns.jsonl'),JSON.stringify({t:Date.now(),where:'private:123',who:'a',text:secret,reply:'ok'})+'\n');
 const diaryDir=path.join(dir,'diary'); fs.mkdirSync(diaryDir);
 fs.writeFileSync(path.join(diaryDir,'diary.jsonl'),JSON.stringify({t:Date.now(),text:secret,title:'x'})+'\n');
 const config=path.join(dir,'config.json'); fs.writeFileSync(config,JSON.stringify({apiKey:'fake',baseUrl:'https://invalid.example',dataDir:dir,diaryDir,roleCard:path.join(dir,'missing')}));
 const captured=path.join(dir,'captured'); const preload=path.join(dir,'mock.mjs');
 fs.writeFileSync(preload,`import fs from 'node:fs'; globalThis.fetch=async (_u,o)=>{fs.writeFileSync(${JSON.stringify(captured)},o.body);return {ok:true,text:async()=>JSON.stringify({choices:[{message:{content:'{"text":"ok"}'}}]})}};`);
 const r=spawnSync(process.execPath,['--import',preload,'src/diary.js','auto','--config',config],{cwd:process.cwd(),env:{...process.env,HOME:dir},encoding:'utf8',timeout:10000});
 assert.equal(r.status,0); assert.ok(!fs.readFileSync(captured,'utf8').includes(secret));
});
