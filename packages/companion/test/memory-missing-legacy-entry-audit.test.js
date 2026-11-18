import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createMemoryBrain} from '../src/memory-brain-adapter.js';
import {initializeManagedStore} from '../src/memory-brain-trust.js';
import {Memory} from '../src/memory.js';
import {OneBot} from '../src/transport-onebot.js';
import {handleTurn} from '../src/index.js';
import {register} from 'node:module';
register('./memory-brain-fake-ws-loader.js', import.meta.url);

const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'};

test('missing default legacy dependency fails closed in the actual chat entry', async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'legacy-unavailable-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const directory=path.join(dir,'memory-brain-scoped'); initializeManagedStore(directory);
 const opts={enabled:true,directory,engineRoot:path.join(dir,'absent-engine'),authorize:async()=>true,recoveryAuthorization:async()=>true};
 const legacy=createMemoryBrain(opts);
 await assert.rejects(legacy.forget(scope,{source:'qq-private-message',evidence:'onebot-message:11'}),/memory-brain unavailable/);
 await assert.rejects(legacy.filterCandidates(scope,{candidates:[{source:'qq-private-message',evidence:'onebot-message:11'}]}),/memory-brain unavailable/);
 const memory=new Memory({dir}); memory.logTurn({where:'private:1',who:'1',text:'secret',reply:'old',identity:{platform:'qq',user:'1',text:'secret',evidence:['onebot-message:11']}});
 let resolve; const bot=new OneBot({wsUrl:'ws://fixture',onMessage:m=>resolve(m)}); bot.api=async()=>({ok:false}); bot.getMyGroupCard=async()=>'';
 while(!bot.ws) await new Promise(r=>setTimeout(r,1)); t.after(()=>bot.close()); bot.ws.emit('open');
 const event=new Promise(r=>resolve=r); bot.ws.emit('message',JSON.stringify({post_type:'message',message_type:'private',user_id:1,message_id:12,message:[{type:'text',data:{text:'new synthetic'}}]}));
 let prompt; await handleTurn({memory,brain:{reply:async p=>{prompt=p;return {text:''}}},bot:{},human:{},waker:{}},[await event],{ownerIds:['1'],dataDir:dir,memoryBrain:{enabled:true,trustedProcess:true,trustedScope:scope,authorizedSources:['qq-private-message'],engineRoot:opts.engineRoot}});
 assert.deepEqual(prompt.history,[]);
 await assert.rejects(prompt.scopedMemoryRecall('secret'),/memory-brain unavailable/);
});
