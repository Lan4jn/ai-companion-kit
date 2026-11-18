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

for (const scenario of [
  {name:'photo plus cross-group plus natural reply', reply:'收到', photo:{ok:true}, expected:['image','group:1','private:42']},
  {name:'photo plus cross-group plus two paragraphs exceeds bubble budget', reply:'好\n\n收到', photo:{ok:true}, expected:['image','group:1']},
  {name:'cross-group content counts toward 50 code point budget', reply:'鱼'.repeat(48), photo:{ok:true}, expected:['image','group:1']},
  {name:'unknown photo stops both group tool and natural reply', reply:'收到', photo:{ok:false,outcome:'unknown'}, expected:['image']},
]) test(`real Brain combined turn: ${scenario.name}`,async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'combined-')); let receive;
 const got=new Promise(r=>receive=r);
 const bot=new OneBot({wsUrl:'ws://127.0.0.1:8765',ingressAuthentication:{enabled:true,trustLoopbackOneBot:true,ownerId:'42'},onMessage:receive});
 t.after(async()=>{await stopOutboxWorker();bot.close();fs.rmSync(dir,{recursive:true,force:true})});
 while(!bot.ws) await new Promise(r=>setTimeout(r,5)); bot.ws.emit('open');
 bot.ws.emit('message',JSON.stringify({post_type:'message',message_type:'private',user_id:42,self_id:99,message_id:201,message:[{type:'text',data:{text:'发送到群 1：大家好'}}],sender:{nickname:'fixture'}}));
 const item=await got, sent=[]; bot.groupMembers=new Map([['1',[]]]);
 bot.send=async(k,m)=>{sent.push([k,m]);return {ok:true}};
 bot.sendImage=async()=>{sent.push(['image']);return scenario.photo};bot.setTyping=async()=>{};bot.getMyGroupCard=async()=>'';
 initGroupBridge({bot,dataDir:dir,limits:{allowedGroups:['1'],minGapMs:0,maxGapMs:0}});
 let req=0;
 t.mock.method(globalThis,'fetch',async(_u,o)=>{const p=JSON.parse(o.body);let message;
   if(p.messages[0]?.content?.includes('你只重新斟酌')) message={content:''};
   else if(p.messages[0]?.content?.includes('根据本轮上下文与已取得的工具结果')) message={content:''};
   else if(p.messages[0]?.content?.includes('你是独立审校员')) message={content:'PASS'};
   else message=++req===1?{tool_calls:[{id:'c',type:'function',function:{name:'queue_group_message',arguments:JSON.stringify({group_id:'1',text:'大家好'})}}]}:{content:scenario.reply};
   return {ok:true,text:async()=>JSON.stringify({choices:[{message}]})};
 });
 const memory={dir,renderPerson:()=>'',renderRecent:()=>'',sessionTurns:()=>[],remember:()=>{},logTurn:()=>{},touch:()=>{}};
 const brain=new Brain({apiKey:'fixture',baseUrl:'https://fixture.invalid',model:'fixture',memory,dataDir:dir,ownerIds:['42']});
 const selfPortrait={wantsPhoto:()=>true,canSend:()=>true,pick:()=>'/synthetic/image',markSent:()=>{}};
 await handleTurn({bot,brain,selfPortrait,human:new Humanizer({enabled:false}),memory,waker:{wake(){}}},[item],{ownerIds:['42'],dataDir:dir});
 assert.deepEqual(sent.map(x=>x[0]),scenario.expected);
 assert.ok(sent.length<=3); assert.ok([...sent.map(x=>x[1]||'').join('')].length<=50);
 if(scenario.photo.outcome==='unknown') assert.equal(req,0);
});
