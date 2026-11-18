import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {register} from 'node:module';
import {handleTurn} from '../src/index.js';
import {OneBot} from '../src/transport-onebot.js';
import {Brain} from '../src/brain.js';
import {Humanizer} from '../src/humanize.js';
import {initGroupBridge,stopOutboxWorker} from '../src/group-bridge.js';
register('./memory-brain-fake-ws-loader.js',import.meta.url);

test('ambiguous synchronous send stops subsequent tools and reply, including after bridge restart',async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'bridge-unknown-'));let receive;
 const got=new Promise(r=>receive=r);const bot=new OneBot({wsUrl:'ws://127.0.0.1:8766',ingressAuthentication:{enabled:true,trustLoopbackOneBot:true,ownerId:'42'},onMessage:receive});
 t.after(async()=>{await stopOutboxWorker();bot.close();fs.rmSync(dir,{recursive:true,force:true})});
 while(!bot.ws) await new Promise(r=>setTimeout(r,5));bot.ws.emit('open');
 bot.ws.emit('message',JSON.stringify({post_type:'message',message_type:'private',user_id:42,self_id:99,message_id:120,message:[{type:'text',data:{text:'发送到群 1：大家好'}}],sender:{nickname:'fixture'}}));
 const item=await got;const sent=[];bot.groupMembers=new Map([['1',[]],['2',[]]]);bot.send=async(k,m)=>{sent.push([k,m]);return {ok:false,outcome:'unknown'}};bot.setTyping=async()=>{};bot.getMyGroupCard=async()=>'';
 initGroupBridge({bot,dataDir:dir,limits:{allowedGroups:['1'],minGapMs:0,maxGapMs:0}});
 let req=0;const results=[];const tool=(id,gid)=>({id,type:'function',function:{name:'queue_group_message',arguments:JSON.stringify({group_id:gid,text:'大家好'})}});
 t.mock.method(globalThis,'fetch',async(_u,o)=>{const body=JSON.parse(o.body);results.push(...body.messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content)));return {ok:true,text:async()=>JSON.stringify({choices:[{message:++req%2?{tool_calls:[tool('c1','1'),tool('c2','1'),tool('c3','2')]}:{content:'收到'}}]})}});
 const memory={dir,renderPerson:()=>'',renderRecent:()=>'',sessionTurns:()=>[],remember:()=>{},logTurn:()=>{},touch:()=>{}};
 const brain=new Brain({apiKey:'fixture',baseUrl:'http://fixture',model:'fixture',memory,ownerIds:['42']});const deps={bot,brain,human:new Humanizer({enabled:false}),memory,waker:{wake(){}}};const cfg={ownerIds:['42'],dataDir:dir};
 await handleTurn(deps,[item],cfg);
 assert.deepEqual(sent,[['group:1','大家好']]);assert.equal(req,1);
 req=0;initGroupBridge({bot,dataDir:dir,limits:{allowedGroups:['1'],minGapMs:0,maxGapMs:0}});await handleTurn(deps,[item],cfg);assert.equal(sent.length,1);
});
