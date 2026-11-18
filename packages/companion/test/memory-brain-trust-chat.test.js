import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {register} from 'node:module';
import {handleTurn} from '../src/index.js';
import {initializeManagedStore} from '../src/memory-brain-trust.js';
import {OneBot} from '../src/transport-onebot.js';
import {recallKnowledge, saveKnowledge} from '../src/bili-living.js';
import {saveFanqieMemory} from '../src/fanqie-session.js';
register('./memory-brain-fake-ws-loader.js', import.meta.url);

async function message(user=1, type='private', id=123) {
 let done; const received=new Promise(r=>done=r);
 const bot=new OneBot({wsUrl:'ws://fixture',onMessage:done});
 bot.api=async()=>({ok:false}); bot.getMyGroupCard=async()=>'';
 while(!bot.ws) await new Promise(r=>setTimeout(r,1));
 bot.ws.emit('open');
 bot.ws.emit('message',JSON.stringify({post_type:'message',message_type:type,user_id:user,group_id:55,message_id:id,message:[{type:'text',data:{text:'BV11T411P7o1 橘猫'}}]}));
 const value=await received; bot.close(); return value;
}

test('configured QQ owner receives three source real ranking with intact evidence, others never do',async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'interest-integrated-'));
 const home=process.env.HOME; process.env.HOME=dir;
 t.after(()=>{process.env.HOME=home;fs.rmSync(dir,{recursive:true,force:true})});
 const text='橘猫在营地晒太阳'; const fingerprint=createHash('sha256').update(text).digest('hex');
 await saveFanqieMemory(dir,{source:'番茄小说屏幕OCR（可能存在识别错误）',text,fingerprint,summary:text,keywords:['橘猫']});
 await saveFanqieMemory(dir,{source:'番茄小说屏幕OCR（可能存在识别错误）',text:'橘猫伪造文字',fingerprint:'a'.repeat(64),summary:'橘猫伪造文字',keywords:['橘猫']});
 fs.writeFileSync(path.join(dir,'tieba-interest.jsonl'),JSON.stringify({version:3,source:'百度贴吧（外部来源）',forum:'肥鱼避难所吧',url:'https://tieba.baidu.com/p/123',keywords:['橘猫'],excerpt:'橘猫帖子晒太阳',capturedAt:new Date().toISOString()})+'\n');
 const obs={source:'visual',start:0,end:10,quote:'橘猫晒太阳'};
 const evidence={version:2,sources:['visual','subtitle'],coverage:{complete:true,duration:10,segments:[{start:0,end:10,visual:'橘猫晒太阳',subtitle:'橘猫'}]},playback:{complete:true,fullWatchVerified:true,duration:10,start:0,end:10,watched:10,samples:Array.from({length:11},(_,i)=>({time:i,wall:i/2,duration:10,rate:2,identity:true,paused:false,seeking:false,ended:i===10}))}};
 assert.ok(saveKnowledge({bvid:'BV11T411P7o1',title:'橘猫晒太阳',up:'合成',duration:10},{points:[obs]},evidence));
 assert.equal(saveKnowledge({bvid:'BV22T411P7o2',title:'橘猫伪造视频',duration:10},{points:[obs]},{...evidence,playback:{...evidence.playback,fullWatchVerified:false}}),null);
 const prompts=[]; const deps={brain:{recall:recallKnowledge,reply:async p=>{prompts.push(p);return {text:''}}},memory:{dir},bot:{},human:{},waker:{}};
 initializeManagedStore(path.join(dir,'memory-brain-scoped'));
 const cfg={ownerIds:['1'],dataDir:dir,tieba:{enabled:true},memoryBrain:{enabled:true,trustedProcess:true,trustedScope:{tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'},authorizedSources:['fanqie-ocr','bili-observation','tieba','qq-private-message']}};
 const owner=await message(); await handleTurn(deps,[owner],cfg);
 const index=prompts.at(-1).situation.split('【memory-brain互联网兴趣索引：')[1];
 assert.ok(index,'configured owner receives interest index');
 const hits=index.split('\n').slice(1).filter(x=>x.startsWith('{')).map(x=>JSON.parse(x));
 assert.deepEqual(new Set(hits.map(h=>h.source)),new Set(['fanqie-ocr','bili-observation','tieba']));
 assert.equal(hits.find(h=>h.source==='fanqie-ocr').evidence,'sha256:'+fingerprint);
 assert.equal(hits.find(h=>h.source==='fanqie-ocr').text,text);
 assert.equal(hits.find(h=>h.source==='bili-observation').evidence,'https://www.bilibili.com/video/BV11T411P7o1');
 assert.match(hits.find(h=>h.source==='bili-observation').text,/橘猫晒太阳/);
 assert.equal(hits.find(h=>h.source==='tieba').evidence,'https://tieba.baidu.com/p/123');
 assert.equal(hits.find(h=>h.source==='tieba').text,'橘猫帖子晒太阳 橘猫');
 assert.ok(!hits.some(h=>h.text.includes('伪造文字')));
 for(const item of [await message(2,'private',124),await message(1,'group',125),{...owner,platform:'bili',messageId:'126'}]){
  await handleTurn(deps,[item],cfg);
  assert.doesNotMatch(prompts.at(-1).situation,/memory-brain互联网兴趣索引/);
 }
});
