import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {register} from 'node:module';
import {createHash} from 'node:crypto';
import {handleTurn} from '../src/index.js';
import {OneBot, isTrustedMemoryMessage} from '../src/transport-onebot.js';
import {saveFanqieMemory} from '../src/fanqie-session.js';
import {initializeManagedStore,createManagedMemoryBrain} from '../src/memory-brain-trust.js';

register('./memory-brain-fake-ws-loader.js', import.meta.url);

test('主人自然询问书名可召回有原文依据的阅读，跨会话混批和无正文摘要不能泄漏', async t => {
 const dir=await fs.mkdtemp(path.join(process.env.TMPDIR,'fanqie-recall-audit-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 await saveFanqieMemory(dir,{bookTitle:'星海旅途',source:'番茄小说屏幕OCR（可能存在识别错误）',text:'营地里的人望着夜空',fingerprint:createHash('sha256').update('营地里的人望着夜空').digest('hex'),progress:{chapter:'第一章',page:1,total:3},summary:'营地里的人望着夜空',keywords:['营地']});
 await saveFanqieMemory(dir,{bookTitle:'星海旅途',source:'OCR',fingerprint:'summary-only',summary:'秘密摘要没有正文',keywords:['营地']});
 const prompts=[]; const deps={brain:{reply:async p=>{prompts.push(p);return {text:''}}},memory:{dir},bot:{},human:{},waker:{}};
 let receive;
 const ingress=new OneBot({wsUrl:'ws://fixture',dataDir:dir,onMessage:item=>receive(item)});
 ingress.api=async()=>({ok:false});
 t.after(()=>ingress.close());
 while(!ingress.ws) await new Promise(resolve=>setTimeout(resolve,5));
 ingress.ws.emit('open');
 assert.equal(ingress.connected,true);
 let messageId=0;
 const msg=async(userId,text)=>{
  const next=new Promise(resolve=>{receive=resolve});
  ingress.ws.emit('message',JSON.stringify({post_type:'message',message_type:'private',user_id:Number(userId),self_id:99,message_id:++messageId,message:[{type:'text',data:{text}}],sender:{nickname:'测试'}}));
  const item=await next;
  assert.equal(isTrustedMemoryMessage(item),true);
  return item;
 };
 const owner=await msg('1','你读的星海旅途怎么样');
 const other=await msg('2','说说营地');
 const ownerAgain=await msg('1','说说营地');
 await handleTurn(deps,[owner],{ownerIds:['1'],dataDir:dir});
 await handleTurn(deps,[other,ownerAgain],{ownerIds:['1'],dataDir:dir});
 await handleTurn(deps,[{...owner}],{ownerIds:['1'],dataDir:dir});
 assert.match(prompts[0].situation,/营地里的人望着夜空/);
 assert.doesNotMatch(prompts[0].situation,/秘密摘要没有正文/);
 assert.doesNotMatch(prompts[1].situation,/营地里的人望着夜空|秘密摘要没有正文/);
 assert.doesNotMatch(prompts[2].situation,/营地里的人望着夜空|秘密摘要没有正文/);
});


test('聊天入口先验证正文并过滤遗忘，再按新到旧选三条且只发送一次', async t => {
 const dir=await fs.mkdtemp(path.join(process.env.TMPDIR,'fanqie-main-order-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'};
 const cfg={dataDir:dir,ownerIds:['1'],memoryBrain:{enabled:true,trustedProcess:true,trustedScope:scope,authorizedSources:['fanqie-ocr']}};
 const directory=path.join(dir,'memory-brain-scoped'); initializeManagedStore(directory);
 const store=createManagedMemoryBrain({directory,scope,sources:['fanqie-ocr'],trustedProcess:true});
 const hash=text=>createHash('sha256').update(text).digest('hex');
 const retained=['保留合成正文甲','保留合成正文乙','保留合成正文丙','保留合成正文丁'];
 const forgotten=['遗忘合成正文甲','遗忘合成正文乙','遗忘合成正文丙'];
 for(const text of [...retained,...forgotten]) {
  await saveFanqieMemory(dir,{source:'番茄小说屏幕OCR（可能存在识别错误）',text,fingerprint:hash(text),summary:'合成阅读摘要',keywords:['合成']});
  if(forgotten.includes(text)) await store.forget(scope,{source:'fanqie-ocr',evidence:'sha256:'+hash(text)});
 }
 await saveFanqieMemory(dir,{source:'OCR',text:'伪造合成正文',fingerprint:hash('另一段正文'),summary:'合成阅读摘要',keywords:['合成']});
 await saveFanqieMemory(dir,{source:'OCR',fingerprint:hash('仅摘要占位'),summary:'仅摘要虚假情节',keywords:['合成']});
 const {tiebaMessage}=await import('./tieba-trusted-message-fixture.js');
 const item=await tiebaMessage({userId:1,text:'最近读了什么小说',id:707});
 assert.equal(isTrustedMemoryMessage(item),true);
 const prompts=[],sent=[];
 const deps={memory:{dir,touch:()=>{}},brain:{reply:async p=>{prompts.push(p);return {text:'我看到合成正文。'}}},
  bot:{send:async(key,text)=>{sent.push({key,text});return {ok:true,outcome:'confirmed'}},setTyping:async()=>{}},
  human:{say:async(parts,{send})=>{for(const part of parts) await send(part);return {ok:true,sent:parts.length,parts}}},waker:{wake:()=>{}}};
 await handleTurn(deps,[item],cfg);
 assert.equal(prompts.length,1);
 const situation=prompts[0].situation;
 for(const text of retained.slice(1)) assert.ok(situation.includes(text),text);
 assert.ok(situation.indexOf(retained[3])<situation.indexOf(retained[2]));
 assert.ok(situation.indexOf(retained[2])<situation.indexOf(retained[1]));
 assert.doesNotMatch(situation,/保留合成正文甲|遗忘合成正文|伪造合成正文|仅摘要虚假情节/);
 assert.match(situation,/不得推测未记录的书名或剧情/);
 assert.deepEqual(sent,[{key:'private:1',text:'我看到合成正文。'}]);
 const wrongScope={...cfg,memoryBrain:{...cfg.memoryBrain,trustedScope:{...scope,user:'2'}}};
 await handleTurn(deps,[item],wrongScope);
 assert.doesNotMatch(prompts[1].situation,/保留合成正文|遗忘合成正文|伪造合成正文|仅摘要虚假情节/);
 assert.equal(sent.length,2);
});
