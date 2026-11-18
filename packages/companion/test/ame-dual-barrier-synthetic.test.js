import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Memory} from '../src/memory.js';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

test('ordinary history sees AME forget even with backend disabled', async t => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'ame-barrier-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const directory=path.join(dir,'memory-brain-scoped');
 const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'};
 const m=new Memory({dir});
 m.logTurn({where:'private:1',who:'1',text:'synthetic',reply:'reply'});
 fs.mkdirSync(directory,{mode:0o700});
 const hash=createHash('sha256').update(JSON.stringify([scope,'qq-private-message'])).digest('hex');
 const db=path.join(directory,`ame-v1-${hash}.sqlite3`);
 execFileSync('/usr/bin/python3',['-c',"import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('create table ame_identity (identity text, retention integer, revoked integer)'); c.execute('insert into ame_identity values (?, 1, 0)',(sys.argv[2],)); c.execute('create table ame_tombstones (digest text primary key)'); c.execute('insert into ame_tombstones values (?)',('a'*64,)); c.commit()",db,JSON.stringify([scope,'qq-private-message'])]);
 fs.chmodSync(db,0o600);
 assert.notEqual(m.privateForgetRevision('private:1'),null);
 assert.notEqual(m.privateForgetRevision('private:1'),'empty');
 assert.deepEqual(m.sessionTurns('private:1'),[]);
 m.logTurn({where:'private:2',who:'2',text:'unrelated',reply:'reply'});
 assert.equal(m.sessionTurns('private:2').length,1);
 execFileSync('/usr/bin/python3',['-c',"import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute(\"update ame_identity set identity='invalid'\"); c.commit()",db]);
 assert.equal(m.privateForgetRevision('private:1'),null);
 assert.deepEqual(m.sessionTurns('private:1'),[]);
});
