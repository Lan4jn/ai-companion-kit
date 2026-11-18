import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Brain } from '../src/brain.js';
import { Memory } from '../src/memory.js';

test('chat prompts isolate private sources while retaining same-session history', async t => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'context-isolation-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const memory=new Memory({dir});
 for (const [where,text] of [['private:578021239','QQ_SECRET'],['private:bili:42','BILI_SECRET'],['private:other','OTHER_SECRET'],['group:1','GROUP_ONE'],['group:2','GROUP_TWO']]) memory.logTurn({where,who:'x',text,reply:'ok'});
 memory.remember('578021239',{fact:'PERSON_SECRET'}); memory.logDiary({details:'DIARY_SECRET'});
 const requests=[]; t.mock.method(globalThis,'fetch',async (_url,options)=>{requests.push(JSON.parse(options.body));return {ok:true,text:async()=>JSON.stringify({choices:[{message:{content:'ok'}}]})}});
 const brain=new Brain({apiKey:'unused',baseUrl:'http://invalid.local',model:'test',dataDir:dir,memory,role:{build:x=>JSON.stringify(x)}});
 for (const input of [{key:'private:bili:42',userId:'578021239',platform:'bilibili'}, {key:'group:1',userId:'578021239'}, {key:'private:other',userId:'other'}, {key:'private:578021239',userId:'578021239'}]) {
  await brain.reply({...input,text:'hello',history:memory.sessionTurns(input.key),record:false,tools:false});
 }
 const prompts=requests.map(r=>JSON.stringify(r.messages));
 for (const [i,expected] of [[0,'BILI_SECRET'],[1,'GROUP_ONE'],[2,'OTHER_SECRET'],[3,'QQ_SECRET']]) assert.ok(prompts[i].includes(expected));
 for (const [i,forbidden] of [[0,['QQ_SECRET','OTHER_SECRET','PERSON_SECRET','DIARY_SECRET','GROUP_ONE']], [1,['QQ_SECRET','BILI_SECRET','OTHER_SECRET','PERSON_SECRET','DIARY_SECRET','GROUP_TWO']], [2,['QQ_SECRET','BILI_SECRET','PERSON_SECRET','DIARY_SECRET','GROUP_ONE']], [3,['BILI_SECRET','OTHER_SECRET','PERSON_SECRET','DIARY_SECRET']]]) for(const s of forbidden) assert.ok(!prompts[i].includes(s),`${i} leaked ${s}`);
});

test('Bili JSON conversation with missing video evidence fails closed', async t => {
 let request; t.mock.method(globalThis,'fetch',async (_url,options)=>{request=JSON.parse(options.body);return {ok:true,text:async()=>JSON.stringify({choices:[{message:{content:'{"reply":true,"text":"不知道"}'}}]})}});
 const brain=new Brain({apiKey:'unused',baseUrl:'http://invalid.local',model:'test',dataDir:process.env.TMPDIR,memory:{renderPerson:()=>'',renderRecent:()=>''},role:{build:x=>JSON.stringify(x)}});
 const result=await brain.reply({key:'private:bili:42',userId:'578021239',platform:'bilibili',text:'你看过的视频讲了什么？只输出 JSON',record:false,tools:false});
 assert.equal(request,undefined); const reply=JSON.parse(result.text); assert.equal(reply.reply,true); assert.match(reply.text,/不知道|没有可靠|没找到/);
});
