import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createMemoryBrain} from '../src/memory-brain-adapter.js';

test('legacy candidate filtering honors an existing AME tombstone for the same scope and source', async t => {
 const directory=fs.mkdtempSync(path.join(process.env.TMPDIR,'ame-cross-'));
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'};
 const source='qq-private-message', evidence='onebot-message:101';
 const hash=createHash('sha256').update(JSON.stringify([scope,source])).digest('hex');
 const file=path.join(directory,`ame-v1-${hash}.sqlite3`);
 execFileSync('/usr/bin/python3',['-c',"import sqlite3,sys,hashlib; c=sqlite3.connect(sys.argv[1]); c.execute('create table ame_identity (identity text, retention integer, revoked integer)'); c.execute('insert into ame_identity values (?, 1000, 0)',(sys.argv[2],)); c.execute('create table ame_tombstones (digest text primary key)'); c.execute('insert into ame_tombstones values (?)',(hashlib.sha256(sys.argv[3].encode()).hexdigest(),)); c.commit()",file,JSON.stringify([scope,source]),evidence]);
 fs.chmodSync(file,0o600);
 const store=createMemoryBrain({enabled:true,directory,authorize:async()=>true,recoveryAuthorization:async()=>true});
 assert.deepEqual(await store.filterCandidates(scope,{candidates:[{source,evidence},{source:'different-source',evidence}]}),[1]);
 assert.equal(await store.commitChatHistory(scope,{turnId:'turn-a',events:[evidence],text:'synthetic',reply:'reply'}),'forgotten');
 await assert.rejects(store.remember(scope,{source,evidence,text:'synthetic'}),/forgotten/);
 const other={...scope,session:'private:2',user:'2'};
 assert.deepEqual(await store.filterCandidates(other,{candidates:[{source,evidence}]}),[0]);
 // A previously committed turn must disappear after the opposite backend forgets it.
 const later='onebot-message:102';
 assert.equal(await store.commitChatHistory(scope,{turnId:'turn-b',events:[later],text:'synthetic',reply:'reply'}),'inserted');
 assert.equal((await store.chatHistory(scope)).length,1);
 execFileSync('/usr/bin/python3',['-c',"import sqlite3,sys,hashlib; c=sqlite3.connect(sys.argv[1]); c.execute('insert into ame_tombstones values (?)',(hashlib.sha256(sys.argv[2].encode()).hexdigest(),)); c.commit()",file,later]);
 assert.deepEqual(await store.chatHistory(scope),[]);
 execFileSync('/usr/bin/python3',['-c',"import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute(\"update ame_identity set identity='invalid'\"); c.commit()",file]);
 await assert.rejects(store.filterCandidates(scope,{candidates:[{source,evidence}]}));
});
