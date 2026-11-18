import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Memory} from '../src/memory.js';
import {register} from 'node:module';
import {handleTurn} from '../src/index.js';
import {initializeManagedStore, createManagedMemoryBrain} from '../src/memory-brain-trust.js';
import {OneBot} from '../src/transport-onebot.js';
register('./memory-brain-fake-ws-loader.js', import.meta.url);

test('scoped private history filters each evidenced message and hides ambiguous legacy turns', async t => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'turn-filter-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const memory=new Memory({dir});
 memory.logTurn({where:'private:1',who:'x',text:'legacy secret',reply:'old'});
 fs.mkdirSync(path.join(dir,'memory-brain-scoped'));
 for (const [ids,text] of [[['11'],'safe'],[['12'],'forgotten'],[['13','14'],'mixed']]) memory.logTurn({where:'private:1',who:'x',text,reply:'ok',identity:{platform:'qq',user:'1',text,evidence:ids.map(id=>`onebot-message:${id}`)}});
 const rows=await memory.sessionTurnsFiltered('private:1',80,async evidence=>evidence.filter(e=>!['onebot-message:12','onebot-message:14'].includes(e)));
 assert.deepEqual(rows.map(r=>r.text),['safe']);
 assert.deepEqual(await memory.sessionTurnsFiltered('private:2',80,async e=>e),[]);
 assert.deepEqual(memory.sessionTurns('private:1'),[]);
});

test('trusted live entry records identity and applies real scoped tombstones', async t => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'turn-entry-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'};
 const directory=path.join(dir,'memory-brain-scoped'); initializeManagedStore(directory);
 const store=createManagedMemoryBrain({directory,scope,sources:['qq-private-message'],trustedProcess:true,backend:'sqlite-fts'});
 const memory=new Memory({dir}); const prompts=[];
 const brain={reply:async p=>{prompts.push(p); memory.logTurn({where:p.key,who:p.userName,text:p.text,reply:'synthetic assistant',identity:p.historyIdentity}); return {text:''};}};
 let resolve; const received=()=>new Promise(r=>resolve=r);
 const bot=new OneBot({wsUrl:'ws://fixture',onMessage:m=>resolve(m)}); bot.api=async()=>({ok:false}); bot.getMyGroupCard=async()=>'';
 while(!bot.ws) await new Promise(r=>setTimeout(r,1)); t.after(()=>bot.close());
 bot.ws.emit('open');
 const send=async (id,text,user=1)=>{const wait=received();bot.ws.emit('message',JSON.stringify({post_type:'message',message_type:'private',user_id:user,message_id:id,message:[{type:'text',data:{text}}]})); const msg=await wait; await handleTurn({brain,memory,bot:{},human:{},waker:{}},[msg],{ownerIds:['1'],dataDir:dir,memoryBrain:{enabled:true,backend:'sqlite-fts',trustedProcess:true,trustedScope:scope,authorizedSources:['qq-private-message']}});};
 await send(11,'first'); await send(12,'second');
 assert.match(prompts[1].history[0].text,/first$/); assert.equal(prompts[1].history[0].reply,'synthetic assistant');
 await store.forget(scope,{source:'qq-private-message',evidence:'onebot-message:11'});
 await send(13,'third');
 assert.equal(prompts[2].history.length,1); assert.match(prompts[2].history[0].text,/second$/);
 await send(14,'other',2); assert.deepEqual(prompts[3].history,[]);
});
