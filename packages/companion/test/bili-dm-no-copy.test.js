import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {createMemoryBrain} from '../src/memory-brain-adapter.js';
import {openBiliDMLedger,biliDMScope,biliDMEvidence} from '../src/bili-dm-ledger.js';

test('ledger retains no text and reconstructs authorized history from memory',async()=>{
 const home=fs.mkdtempSync(path.join(process.env.TMPDIR,'bili-ledger-')); const old=process.env.HOME; process.env.HOME=home;
 const store=createMemoryBrain({enabled:true,backend:'sqlite-fts',directory:path.join(home,'memory'),authorize:async()=>true,recoveryAuthorization:async()=>true});
 try {const l=openBiliDMLedger('9','42'); await l.observe(store,'1','user','unique-private-text'); assert.deepEqual(await l.history(store),[{role:'user',content:'unique-private-text'}]); l.close();
 const db=new Database(path.join(home,'.bili-ai/dm-ledger/ledger.sqlite3'),{readonly:true}); assert(!JSON.stringify(db.prepare('SELECT * FROM observations').all()).includes('unique-private-text')); db.close();
 const l2=openBiliDMLedger('9','42'); await store.forget(biliDMScope('9','42'),{source:'bili-private-message',evidence:biliDMEvidence('9','42','1')}); assert.deepEqual(await l2.history(store),[]); l2.close();
 } finally {process.env.HOME=old; fs.rmSync(home,{recursive:true,force:true});}
});
