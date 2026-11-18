import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {handleTurn} from '../src/index.js';
import {tiebaMessage} from './tieba-trusted-message-fixture.js';
import {initializeManagedStore,createManagedMemoryBrain} from '../src/memory-brain-trust.js';

test('exact forget receipts respect 50-code-point boundary, scope, tombstones and unknown delivery',async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'receipt-forget-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const directory=path.join(dir,'memory-brain-scoped'); initializeManagedStore(directory);
 const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'};
 const other={...scope,session:'private:2',user:'2'};
 const options={directory,scope,sources:['qq-private-message'],trustedProcess:true,backend:'sqlite-fts'};
 const store=createManagedMemoryBrain(options), otherStore=createManagedMemoryBrain({...options,scope:other});
 const cfg={ownerIds:['1'],dataDir:dir,memoryBrain:{enabled:true,backend:'sqlite-fts',trustedProcess:true,trustedScope:scope,authorizedSources:['qq-private-message']}};
 const base=[...`已遗忘当前QQ私聊消息ID 的单条接通记忆；备份等副本和持久队列不在范围。`].length;
 const ids=['1'.repeat(50-base),'2'.repeat(51-base),'3'.repeat(200),'45'];
 for(const id of ids) await store.remember(scope,{text:'合成记忆',source:'qq-private-message',evidence:`onebot-message:${id}`});
 await otherStore.remember(other,{text:'另一作用域',source:'qq-private-message',evidence:`onebot-message:${ids[0]}`});
 const sent=[]; let revision=0, unknown=false, changing=true;
 const deps={bot:{send:async(_k,s)=>{sent.push(s);if(unknown) throw Error('unknown');return {ok:true}}},memory:{dir,privateForgetRevision:()=>changing ? revision++ : revision},brain:{},human:{},waker:{}};
 const run=async id=>{sent.length=0;await handleTurn(deps,[await tiebaMessage({text:`忘记这条聊天记忆：消息ID ${id}`,id:500})],cfg);return sent.join('');};
 for(let i=0;i<3;i++){
  const receipt=await run(ids[i]); assert.equal(sent.length,1);assert.ok([...receipt].length<=50);assert.match(receipt,/当前QQ私聊.*单条接通记忆.*备份.*持久队列/);
  if(i===0){assert.equal([...receipt].length,50);assert.ok(receipt.includes(ids[i]));}
  else {assert.ok(!receipt.includes('消息ID'));assert.ok(!receipt.includes(ids[i]));assert.match(receipt,/指定/);}
 }
 assert.equal((await otherStore.privateHistory(other)).length,1);
 assert.deepEqual((await store.privateHistory(scope)).map(x=>x.evidence),['onebot-message:45']);
 const script=`import sqlite3,glob,sys,hashlib\nrows=[]\nfor f in glob.glob(sys.argv[1]+'/*.sqlite3'):\n c=sqlite3.connect('file:'+f+'?mode=ro',uri=True)\n if c.execute("select count(*) from sqlite_master where name='local_tombstones'").fetchone()[0]: rows.extend(x[0] for x in c.execute('select digest from local_tombstones'))\nfor e in sys.argv[2:]: assert hashlib.sha256(('onebot-message:'+e).encode()).hexdigest() in rows\n`;
 execFileSync('python3',['-c',script,directory,...ids.slice(0,3)]);
 unknown=true;assert.match(await run(ids[3]),/已遗忘/);assert.equal(sent.length,1);unknown=false;changing=false;
 const retry=await run(ids[3]);assert.doesNotMatch(retry,/已遗忘/);assert.match(retry,/没有找到/);
 execFileSync('python3',['-c',script,directory,ids[3]]);
});
