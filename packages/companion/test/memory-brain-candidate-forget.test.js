import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {initializeManagedStore, createManagedMemoryBrain} from '../src/memory-brain-trust.js';

test('forgotten external evidence cannot reappear through candidate ranking', async t => {
 const root=fs.mkdtempSync(path.join(process.env.TMPDIR,'memory-candidate-forget-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const directory=path.join(root,'store'); initializeManagedStore(directory);
 const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'};
 const memory=createManagedMemoryBrain({directory,scope,sources:['tieba'],trustedProcess:true});
 const candidate={text:'合成红色星星',source:'tieba',evidence:'https://example.test/123'};
 assert.equal((await memory.rankCandidates(scope,{query:'红色星星',candidates:[candidate]})).length,1);
 await memory.forget(scope,{source:candidate.source,evidence:candidate.evidence});
 assert.deepEqual(await memory.rankCandidates(scope,{query:'红色星星',candidates:[candidate]}),[]);
});


test('native barrier isolates full scope and evidence without modifying shared records', async t => {
 const root=fs.mkdtempSync(path.join(process.env.TMPDIR,'memory-native-scope-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const directory=path.join(root,'store'); initializeManagedStore(directory);
 const a={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'};
 const b={...a,session:'private:2',user:'2'};
 const first=createManagedMemoryBrain({directory,scope:a,sources:['tieba','fanqie-ocr','bili-observation'],trustedProcess:true});
 const second=createManagedMemoryBrain({directory,scope:b,sources:['tieba','fanqie-ocr','bili-observation'],trustedProcess:true});
 const records=[{source:'tieba',evidence:'https://example.test/a'}, {source:'tieba',evidence:'https://example.test/b'}, {source:'fanqie-ocr',evidence:'sha256:fixture'}, {source:'bili-observation',evidence:'https://www.bilibili.com/video/BV1234567890'}];
 for(const r of [records[0],records[2],records[3]]) await first.forget(a,r);
 assert.deepEqual(await first.filterCandidates(a,{candidates:records}),[1]);
 assert.deepEqual(await second.filterCandidates(b,{candidates:records}),[0,1,2,3]);
 await assert.rejects(first.filterCandidates(b,{candidates:records}));
 await assert.rejects(first.filterCandidates(a,{candidates:[{source:'tieba'}]}));
});
