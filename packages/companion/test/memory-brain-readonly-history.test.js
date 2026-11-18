import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, readdirSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {createMemoryBrain} from '../src/memory-brain-adapter.js';

test('trusted private history reads existing ledger without DB or WAL writes and respects forget', async t => {
 const dir=mkdtempSync(join(tmpdir(),'readonly-history-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const scope={tenant:'t',platform:'qq',type:'private',session:'private:123',user:'123'};
 const store=createMemoryBrain({enabled:true,directory:dir,authorize:async c=>Object.keys(scope).every(k=>c[k]===scope[k]),recoveryAuthorization:async()=>true});
 await store.remember(scope,{text:'喜欢喝茶',source:'qq-private-message',evidence:'onebot-message:1'});
 await store.remember(scope,{text:'不再记住',source:'qq-private-message',evidence:'onebot-message:2'});
 await store.forget(scope,{source:'qq-private-message',evidence:'onebot-message:2'});
 const files=()=>readdirSync(dir).filter(n=>/\.sqlite3(?:-wal)?$/.test(n)).sort();
 const before=Object.fromEntries(files().map(n=>[n,readFileSync(join(dir,n))]));
 const rows=await store.privateHistory(scope,{limit:10});
 assert.deepEqual(rows.map(r=>r.text),['喜欢喝茶']);
 assert.deepEqual(Object.fromEntries(files().map(n=>[n,readFileSync(join(dir,n))])),before);
 for (const bad of [{...scope,type:'group'}, {...scope,user:'124'}, {...scope,platform:'wechat'}]) await assert.rejects(store.privateHistory(bad,{limit:10}));
});

test('read-only history sees uncheckpointed WAL and rejects untrusted provenance', async t => {
 const dir=mkdtempSync(join(tmpdir(),'readonly-wal-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const scope={tenant:'t',platform:'qq',type:'private',session:'private:123',user:'123'};
 const store=createMemoryBrain({enabled:true,directory:dir,authorize:async()=>true,recoveryAuthorization:async()=>true});
 await store.remember(scope,{text:'可信记录',source:'qq-private-message',evidence:'onebot-message:1'});
 const db=join(dir,readdirSync(dir).find(n=>n.endsWith('.sqlite3')));
 const script=`import sqlite3,sys,json\nc=sqlite3.connect(sys.argv[1]); c.execute("insert into memories(text,source,meta,visibility,created_at) values(?,?,?,?,strftime('%s','now'))",('WAL可信','qq-private-message',json.dumps({'scope':{'tenant':'t','platform':'qq','type':'private','session':'private:123','user':'123'},'adapter_version':1,'evidence':'onebot-message:3'}),'private')); c.execute("insert into memories(text,source,meta,visibility,created_at) values(?,?,?,?,strftime('%s','now'))",('伪造','qq-private-message',json.dumps({'scope':{'platform':'wechat'},'adapter_version':1,'evidence':'onebot-message:2'}),'private')); c.commit(); print('ready',flush=True); sys.stdin.readline(); c.close()`;
 const child=spawn('/usr/bin/python3',['-u','-c',script,db],{stdio:['pipe','pipe','pipe']});
 t.after(()=>child.kill()); await once(child.stdout,'data');
 const digest=()=>Object.fromEntries(readdirSync(dir).filter(n=>/\.sqlite3(?:-wal)?$/.test(n)).sort().map(n=>[n,createHash('sha256').update(readFileSync(join(dir,n))).digest('hex')]));
 const before=digest(); assert.ok(Object.keys(before).some(n=>n.endsWith('-wal')));
 const rows=await store.privateHistory(scope); assert.deepEqual(new Set(rows.map(r=>r.text)),new Set(['可信记录','WAL可信'])); assert.deepEqual(digest(),before);
 child.stdin.end('\n'); await once(child,'close');
});
