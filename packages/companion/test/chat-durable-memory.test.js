import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Memory} from '../src/memory.js';
import {createMemoryBrain} from '../src/memory-brain-adapter.js';

const scope=user=>({tenant:'companion',platform:'qq',type:'private',session:`private:${user}`,user});
const makeStore=directory=>createMemoryBrain({enabled:true,backend:'sqlite-fts',directory,authorize:async()=>true,recoveryAuthorization:async()=>true});
const turn=(s,store)=>({where:s.session,who:s.user,text:'hello',reply:'world',evidence:['onebot-message:1'],scope:s,store});

test('scoped durable turns survive restart, deduplicate and isolate sessions', async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'durable-memory-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const directory=path.join(dir,'memory-brain-scoped'), a=scope('123'), b=scope('456');
 const m=new Memory({dir}); let store=makeStore(directory);
 assert.equal(await m.logDurableTurn('batch-1',turn(a,store)),'inserted');
 store=makeStore(directory);
 assert.equal(await m.logDurableTurn('batch-1',turn(a,store)),'duplicate');
 await assert.rejects(m.logDurableTurn('batch-1',{...turn(a,store),reply:'different'}));
 assert.equal(await m.logDurableTurn('batch-1',turn(b,store)),'inserted');
 assert.deepEqual((await store.chatHistory(a)).map(x=>x.turnId),['batch-1']);
 assert.deepEqual((await store.chatHistory(b)).map(x=>x.turnId),['batch-1']);
 await store.forget(a,{source:'qq-private-message',evidence:'onebot-message:1'});
 assert.deepEqual(await store.chatHistory(a),[]);
 assert.equal((await store.chatHistory(b)).length,1);
 assert.equal(await m.logDurableTurn('batch-1',turn(a,store)),'forgotten');
 assert.throws(()=>m.logDurableTurn('legacy',{where:a.session,who:a.user,text:'hello',reply:'world'}),/forget barrier/);
 assert.deepEqual(m.sessionTurns(a.session),[]);
});
