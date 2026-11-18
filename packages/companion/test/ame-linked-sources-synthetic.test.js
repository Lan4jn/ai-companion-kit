import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createMemoryBrain} from '../src/memory-brain-adapter.js';

test('canonical tieba page forget blocks the same page via web, but not unrelated evidence', async t => {
 const directory=fs.mkdtempSync(path.join(process.env.TMPDIR,'ame-linked-'));
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'};
 const source='tieba', evidence='https://tieba.baidu.com/p/123';
 const hash=createHash('sha256').update(JSON.stringify([scope,source])).digest('hex');
 const file=path.join(directory,`ame-v1-${hash}.sqlite3`);
 execFileSync('/usr/bin/python3',['-c',"import sqlite3,sys,hashlib; c=sqlite3.connect(sys.argv[1]); c.execute('create table ame_identity (identity text, retention integer, revoked integer)'); c.execute('insert into ame_identity values (?,1000,0)',(sys.argv[2],)); c.execute('create table ame_tombstones (digest text primary key)'); c.execute('insert into ame_tombstones values (?)',(hashlib.sha256(sys.argv[3].encode()).hexdigest(),)); c.commit()",file,JSON.stringify([scope,source]),evidence]);
 fs.chmodSync(file,0o600);
 const store=createMemoryBrain({enabled:true,directory,authorize:async()=>true,recoveryAuthorization:async()=>true});
 const candidates=[{source:'web-source-page',evidence},{source:'web-source-page',evidence:'https://tieba.baidu.com/p/124'},{source:'other',evidence}];
 assert.deepEqual(await store.filterCandidates(scope,{candidates}),[1,2]);
 assert.deepEqual(await store.rankCandidates(scope,{query:'synthetic',candidates:candidates.map(c=>({...c,text:'synthetic'}))}),[] .concat((await store.rankCandidates(scope,{query:'synthetic',candidates:candidates.slice(1).map(c=>({...c,text:'synthetic'}))}))));
 await assert.rejects(store.remember(scope,{...candidates[0],text:'synthetic'}),/forgotten/);
 const other={...scope,session:'private:2',user:'2'};
 assert.deepEqual(await store.filterCandidates(other,{candidates:[candidates[0]]}),[0]);
});

test('legacy forget propagates in reverse, without matching identical text', async t => {
 const directory=fs.mkdtempSync(path.join(process.env.TMPDIR,'ame-linked-reverse-'));
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'};
 const store=createMemoryBrain({enabled:true,directory,authorize:async()=>true,recoveryAuthorization:async()=>true});
 const evidence='https://tieba.baidu.com/p/123';
 await store.remember(scope,{source:'tieba',evidence,text:'stored before forget'});
 await store.forget(scope,{source:'web-source-page',evidence});
 assert.deepEqual(await store.recall(scope,{query:'stored',sources:['tieba']}),[]);
 const candidates=[{source:'tieba',evidence},{source:'tieba',evidence:'https://tieba.baidu.com/p/124'},{source:'tieba',evidence:evidence+'?x=1'},{source:'other',evidence}];
 assert.deepEqual(await store.filterCandidates(scope,{candidates}),[1,3]);
 await assert.rejects(store.forget(scope,{source:'web-source-page',evidence:evidence+'?x=1'}),/ambiguous/);
 await assert.rejects(store.remember(scope,{...candidates[0],text:'same wording'}),/forgotten/);
 await store.remember(scope,{...candidates[1],text:'same wording'});
 assert.equal((await store.recall(scope,{query:'same',sources:['tieba']})).length,1);
});
