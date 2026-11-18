import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Brain} from '../src/brain.js';
import {Role} from '../src/role.js';
import {handleTurn} from '../src/index.js';
import {Humanizer} from '../src/humanize.js';
import {loopGuard} from '../src/loop-guard.js';

test('群友默认用温和人格且真实道歉可送达', async t => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'gentle-role-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const base=path.join(dir,'base.md'), alt=path.join(dir,'alt.md');
 fs.writeFileSync(base,'合成温和角色卡'); fs.writeFileSync(alt,'合成毒舌角色卡');
 const memory={dir,renderPerson:()=>'',renderRecent:()=>'',sessionTurns:()=>[],remember:()=>{},logTurn:()=>{},touch:()=>{}};
 const role=new Role({cardPath:base,altCardPath:alt,maxChars:50000});
 const brain=new Brain({apiKey:'fixture',baseUrl:'https://fixture.invalid/v1',model:'fixture',role,memory,dataDir:dir,ownerIds:[]});
 const requests=[];t.mock.method(globalThis,'fetch',async(_u,o)=>{requests.push(JSON.parse(o.body));const body={choices:[{finish_reason:'stop',message:{content:'对不起，这次是我错了'}}]};return {ok:true,status:200,text:async()=>JSON.stringify(body),json:async()=>body}});
 t.mock.method(Math,'random',()=>0);
 const sent=[];const bot={send:async(_k,m)=>{sent.push(m);return {ok:true}},setTyping:async()=>{},getMyGroupCard:async()=>''};
 const item={key:'group:fixture',platform:'qq',isGroup:true,groupId:'fixture',userId:'fixture-user',name:'fixture',text:'刚刚你说错了',images:[],raw:{},isAtMe:true,isPoke:false,replyTo:null,messageId:'fixture',time:Date.now()};
 loopGuard.state.clear();
 await handleTurn({bot,brain,human:new Humanizer({enabled:false}),memory,waker:{wake(){}}},[item],{ownerIds:[],dataDir:dir});
 assert.ok(requests.length>0);const prompt=JSON.stringify(requests[0].messages);
 assert.match(prompt,/合成温和角色卡/);assert.doesNotMatch(prompt,/合成毒舌角色卡|直接怼|查户口呢你|冲上去咬/);
 assert.deepEqual(sent,['对不起，这次是我错了']);
});
