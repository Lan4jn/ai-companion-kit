import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {register} from 'node:module';
import {Memory} from '../src/memory.js';
import {Brain} from '../src/brain.js';
import {handleTurn} from '../src/index.js';
import {OneBot} from '../src/transport-onebot.js';
register('./memory-brain-fake-ws-loader.js', import.meta.url);

test('unavailable scoped store cannot leak old recall via real Brain', async t => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'recall-failure-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const memory=new Memory({dir});
 memory.logTurn({where:'private:1',who:'1',text:'needle secret old',reply:'private answer'});
 for(let i=0;i<81;i++) memory.logTurn({where:'private:1',who:'1',text:'unrelated '+i,reply:'ok'});
 const requests=[];
 t.mock.method(globalThis,'fetch',async (_url,opts)=>{requests.push(JSON.parse(opts.body));return {ok:true,text:async()=>JSON.stringify({choices:[{message:{content:'好'}}]})};});
 const brain=new Brain({apiKey:'fixture',baseUrl:'http://fixture',role:{build:({situation})=>situation},memory,dataDir:dir,ownerIds:['1']});
 let resolve;const received=new Promise(r=>resolve=r); const bot=new OneBot({wsUrl:'ws://fixture',onMessage:resolve});bot.api=async()=>({ok:false});bot.getMyGroupCard=async()=>'';
 while(!bot.ws) await new Promise(r=>setTimeout(r,1));t.after(()=>bot.close());bot.ws.emit('open');bot.ws.emit('message',JSON.stringify({post_type:'message',message_type:'private',user_id:1,message_id:200,message:[{type:'text',data:{text:'needle secret'}}]}));
 const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'};
 await handleTurn({brain,memory,bot:{},human:{say:async()=>({ok:true})},waker:{}},[await received],{ownerIds:['1'],dataDir:dir,memoryBrain:{enabled:true,backend:'sqlite-fts',trustedProcess:true,trustedScope:scope,authorizedSources:['qq-private-message']}});
 assert.ok(requests.length);assert.doesNotMatch(JSON.stringify(requests),/needle secret old|private answer/);
});
