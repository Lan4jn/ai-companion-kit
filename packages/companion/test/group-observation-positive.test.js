import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {WebSocketServer} from 'ws';
import {OneBot,snapshotAuthenticatedOneBotGroupMessage} from '../src/transport-onebot.js';
import {createGroupObservationStore} from '../src/group-observation-store.js';
import {initializeManagedStore,createManagedMemoryBrain} from '../src/memory-brain-trust.js';

test('authenticated loopback group ingress, scoped observation and forget',async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'group-observation-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 initializeManagedStore(path.join(dir,'memory-brain-scoped'));
 const server=new WebSocketServer({host:'127.0.0.1',port:0}); await new Promise(r=>server.once('listening',r));
 let peer; const connection=new Promise(r=>server.once('connection',s=>{peer=s;r();}));
 let receive;const bot=new OneBot({wsUrl:`ws://127.0.0.1:${server.address().port}`,dataDir:dir,ingressAuthentication:{enabled:true,trustLoopbackOneBot:true,ownerId:'1'},onMessage:m=>receive(m)});
 bot.api=async()=>({ok:false});bot.getMyGroupCard=async()=>'';
 t.after(()=>{bot.close();server.close();}); await connection;
 const repo=createGroupObservationStore({dataDir:dir,bot,account:'99',allowedGroups:['10','20']});t.after(()=>repo.close());
 async function event(gid,id,text){const p=new Promise(r=>receive=r);peer.send(JSON.stringify({post_type:'message',message_type:'group',self_id:99,group_id:gid,user_id:2,message_id:id,message:[{type:'text',data:{text}}]}));return p;}
 const a=await event(10,1,'first');const ea=await repo.observe(a);const b=await event(20,2,'other group');await repo.observe(b);const c=await event(10,3,'second');await repo.observe(c);
 assert.deepEqual(await repo.withObserved(c,rows=>rows.map(x=>x.text)),['first','second']);
 await assert.rejects(repo.observe({...a}),/untrusted/);
 const scope={tenant:'companion',platform:'qq',type:'group',session:'group:10',user:'group:10'};
 const store=createManagedMemoryBrain({directory:path.join(dir,'memory-brain-scoped'),scope,sources:['qq-group-observation'],trustedProcess:true,backend:'sqlite-fts'});
 let release, entered; const held=new Promise(r=>release=r), ready=new Promise(r=>entered=r);
 const reading=repo.withObserved(c,async rows=>{assert.equal(rows.length,2);entered();await held;});
 await ready; let forgotten=false; const forgetting=store.forget(scope,{source:'qq-group-observation',evidence:ea}).then(()=>{forgotten=true;});
 await new Promise(r=>setTimeout(r,100));assert.equal(forgotten,false);release();await reading;await forgetting;
 assert.deepEqual(await repo.withObserved(c,rows=>rows.map(x=>x.text)),['second']);
 await assert.rejects(repo.observe(a),/forgotten/);
 assert.deepEqual(await repo.withObserved(b,rows=>rows.map(x=>x.text)),['other group']);
 bot.close(); assert.throws(()=>snapshotAuthenticatedOneBotGroupMessage(bot,c),/untrusted/);
});
