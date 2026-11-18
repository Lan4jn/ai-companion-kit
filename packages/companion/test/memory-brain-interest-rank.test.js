import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readdirSync, readFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {createMemoryBrain} from '../src/memory-brain-adapter.js';

test('real core ranks transient sourced candidates without persisting them', async t => {
 const dir=mkdtempSync(join(process.env.TMPDIR,'mb-interest-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const scope={tenant:'t',platform:'qq',type:'private',session:'private:1',user:'1'};
 const mb=createMemoryBrain({enabled:true,directory:dir,authorize:async()=>true,recoveryAuthorization:async()=>true});
 const candidates=[{text:'橘猫喜欢晒太阳',source:'tieba',evidence:'https://tieba.baidu.com/p/123'},{text:'电子游戏更新',source:'bili',evidence:'BV1234567890'}];
 const hits=await mb.rankCandidates(scope,{query:'橘猫',candidates});
 assert.deepEqual(hits.map(x=>x.evidence),['https://tieba.baidu.com/p/123']);
 for (const file of readdirSync(dir).filter(f => !f.startsWith('.'))) {
  assert.match(file,/^[a-f0-9]{64}\.sqlite3(?:\.lock)?$/);
  const bytes=readFileSync(join(dir,file));
  for (const record of candidates) for (const secret of Object.values(record)) assert.equal(bytes.includes(Buffer.from(secret)),false);
 }
 await assert.rejects(mb.rankCandidates(scope,{query:'橘猫',candidates:[{text:'橘猫',source:'tieba'}]}));
 const denied=createMemoryBrain({enabled:true,directory:dir,authorize:async()=>false,recoveryAuthorization:async()=>true});
 await assert.rejects(denied.rankCandidates(scope,{query:'橘猫',candidates}));
});
