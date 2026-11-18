import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {initializeManagedStore} from '../src/memory-brain-trust.js';
import {createBiliDMMemory} from '../src/bili-dm-startup.js';
import {biliDMScope} from '../src/bili-dm-ledger.js';
test('startup memory needs explicit account and peers and denies other scopes',async()=>{
 const home=fs.mkdtempSync(path.join(process.env.TMPDIR,'bili-start-')); const dir=path.join(home,'store');
 try {initializeManagedStore(dir); assert.equal(createBiliDMMemory({}),null);
 const store=createBiliDMMemory({enabled:true,directory:dir,account:'9',peers:['42']});
 assert(await store.remember(biliDMScope('9','42'),{source:'bili-private-message',evidence:'bili-dm:9:42:1',text:'hello'}));
 await assert.rejects(store.remember(biliDMScope('9','43'),{source:'bili-private-message',evidence:'bili-dm:9:43:1',text:'bad'}));
 await assert.rejects(store.remember(biliDMScope('10','42'),{source:'bili-private-message',evidence:'bili-dm:10:42:1',text:'bad'}));
 } finally {fs.rmSync(home,{recursive:true,force:true});}
});
