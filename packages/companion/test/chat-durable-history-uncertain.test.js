import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createMemoryBrain} from '../src/memory-brain-adapter.js';

test('private history fails closed on malformed forget tombstone', async t => {
 const dir=mkdtempSync(join(process.env.TMPDIR,'history-provenance-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const scope={tenant:'fixture',platform:'qq',type:'private',session:'private:123',user:'123'};
 const store=createMemoryBrain({enabled:true,backend:'sqlite-fts',directory:dir,authorize:async()=>true,recoveryAuthorization:async()=>true});
 await store.remember(scope,{text:'fixture',source:'qq-private-message',evidence:'onebot-message:1'});
 const db=join(dir,readdirSync(dir).find(n=>n.endsWith('.sqlite3')));
 execFileSync('/usr/bin/python3',['-c',"import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute(\"insert into local_tombstones values ('invalid')\"); c.commit()",db]);
 await assert.rejects(store.privateHistory(scope),/memory-brain unavailable/);
});
