import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {initializeManagedStore, createManagedMemoryBrain} from '../src/memory-brain-trust.js';

test('forgotten message cannot be reintroduced by redelivery, including after restart', async t => {
 const root=fs.mkdtempSync(path.join(process.env.TMPDIR,'memory-forget-redelivery-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const directory=path.join(root,'store'); initializeManagedStore(directory);
 const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'};
 const make=()=>createManagedMemoryBrain({directory,scope,sources:['qq-private-message'],trustedProcess:true});
 const record={text:'合成红色星星',source:'qq-private-message',evidence:'onebot-message:123'};
 const first=make(); await first.remember(scope,record);
 assert.equal(await first.forget(scope,{source:record.source,evidence:record.evidence}),1);
 const restarted=make();
 await assert.rejects(restarted.remember(scope,record));
 assert.deepEqual(await restarted.recall(scope,{query:'红色星星',sources:[record.source]}),[]);
});
