import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {createMemoryBrain} from '../src/memory-brain-adapter.js';

test('stdlib backend isolates scopes and honors authorization and cross-backend forget', async t => {
 const directory=fs.mkdtempSync(path.join(process.env.TMPDIR,'fts-local-'));
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const scope={tenant:'test',platform:'qq',type:'private',session:'private:1',user:'1'};
 const opts={enabled:true,directory,authorize:async (_c,_op,source)=>source==='qq-private-message',recoveryAuthorization:async()=>true};
 const local=createMemoryBrain({...opts,backend:'sqlite-fts'});
 const legacy=createMemoryBrain({...opts,backend:'legacy'});
 const source='qq-private-message', evidence='onebot-message:123';
 await local.remember(scope,{source,evidence,text:'我们喜欢三体黑暗森林这本书'});
 assert.equal((await local.recall(scope,{sources:[source],query:'你喜欢什么三体黑暗森林？'})).length,1);
 assert.deepEqual(await local.recall({...scope,user:'2',session:'private:2'},{sources:[source],query:'三体黑暗森林'}),[]);
 await assert.rejects(local.remember(scope,{source:'denied',evidence,text:'x'}),/denied/);
 await local.forget(scope,{source,evidence});
 assert.deepEqual(await local.recall(scope,{sources:[source],query:'三体黑暗森林'}),[]);
 assert.deepEqual(await legacy.filterCandidates(scope,{candidates:[{source,evidence}]}),[]);
 await legacy.forget(scope,{source,evidence:'onebot-message:999'});
 await assert.rejects(legacy.remember(scope,{source,evidence,text:'synthetic'}),/forgotten/);
 const reverse='onebot-message:124';
 await local.remember(scope,{source,evidence:reverse,text:'synthetic reverse'});
 await legacy.forget(scope,{source,evidence:reverse});
 assert.deepEqual(await local.recall(scope,{sources:[source],query:'reverse'}),[]);
 assert.deepEqual(await local.filterCandidates(scope,{candidates:[{source,evidence:reverse}]}),[]);
 const files=fs.readdirSync(directory);
 assert.ok(files.some(x=>x.startsWith('sqlite-fts-v1-') && x.endsWith('.sqlite3')));
 assert.ok(files.some(x=>/^[a-f0-9]{64}\.sqlite3$/.test(x)));
});

test('rejected cross-backend writes do not leave an invalid legacy ledger', async t => {
 const directory=fs.mkdtempSync(path.join(process.env.TMPDIR,'fts-rejected-'));
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const scope={tenant:'test',platform:'qq',type:'private',session:'private:1',user:'1'};
 const opts={enabled:true,directory,authorize:async()=>true,recoveryAuthorization:async()=>true};
 const local=createMemoryBrain({...opts,backend:'sqlite-fts'});
 const legacy=createMemoryBrain({...opts,backend:'legacy'});
 const source='qq-private-message', evidence='onebot-message:123';
 await local.forget(scope,{source,evidence});
 await assert.rejects(legacy.remember(scope,{source,evidence,text:'rejected'}),/forgotten/);
 assert.equal(fs.readdirSync(directory).some(x=>/^[a-f0-9]{64}\.sqlite3$/.test(x)),false);
 await local.remember(scope,{source,evidence:'onebot-message:124',text:'allowed'});
 assert.equal((await local.recall(scope,{sources:[source],query:'allowed'})).length,1);
});

test('existing incomplete legacy databases remain fail-closed', async t => {
 for (const kind of ['empty', 'corrupt', 'unrelated-table']) {
  const directory=fs.mkdtempSync(path.join(process.env.TMPDIR,'fts-invalid-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const scope={tenant:'test',platform:'qq',type:'private',session:'private:1',user:'1'};
  const source='qq-private-message';
  const hash=createHash('sha256').update(JSON.stringify([scope,source])).digest('hex');
  const file=path.join(directory,`${hash}.sqlite3`);
  if (kind === 'corrupt') fs.writeFileSync(file,'not a database',{mode:0o600});
  else {
   fs.writeFileSync(file,'',{mode:0o600});
   if (kind === 'unrelated-table') { const db=new Database(file); db.exec('CREATE TABLE existing_data (value TEXT); INSERT INTO existing_data VALUES (\'keep\')'); db.close(); }
  }
  const before=fs.readFileSync(file);
  const local=createMemoryBrain({enabled:true,backend:'sqlite-fts',directory,authorize:async()=>true,recoveryAuthorization:async()=>true});
  await assert.rejects(local.remember(scope,{source,evidence:'onebot-message:1',text:'blocked'}));
  assert.deepEqual(fs.readFileSync(file),before);
 }
});

test('local transactional forget handles merged turns and refuses redelivery', async t => {
 const directory=fs.mkdtempSync(path.join(process.env.TMPDIR,'fts-local-'));
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const scope={tenant:'test',platform:'qq',type:'private',session:'private:1',user:'1'};
 const store=createMemoryBrain({enabled:true,backend:'sqlite-fts',directory,authorize:async()=>true,recoveryAuthorization:async()=>true});
 const source='qq-private-message', e1='onebot-message:1', e2='onebot-message:2';
 const turn={turnId:'synthetic-turn',events:[e1,e2],text:'hello',reply:'world'};
 assert.equal(await store.commitChatHistory(scope,turn),'inserted');
 assert.equal(await store.commitChatHistory(scope,turn),'duplicate');
 await assert.rejects(store.forget(scope,{source,evidence:e1,exactSingle:true}));
 assert.equal((await store.chatHistory(scope)).length,1);
 await store.forget(scope,{source,evidence:e1});
 assert.deepEqual(await store.chatHistory(scope),[]);
 assert.equal(await store.commitChatHistory(scope,turn),'forgotten');
 assert.deepEqual(await store.filterCandidates(scope,{candidates:[{source,evidence:e1},{source,evidence:e2}]}),[1]);
 assert.equal((await store.rankCandidates(scope,{query:'alpha',candidates:[{source,evidence:e1,text:'alpha'},{source,evidence:e2,text:'alpha'}]})).length,1);
});
