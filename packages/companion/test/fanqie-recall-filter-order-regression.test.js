import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {recallFanqie,saveFanqieMemory} from '../src/fanqie-session.js';
import {createFanqieBackgroundFilter} from '../src/fanqie-startup.js';
import {initializeManagedStore,createManagedMemoryBrain} from '../src/memory-brain-trust.js';

test('遗忘的近期阅读不能挤掉仍授权的真实 OCR 证据', async t => {
 const dir=await fs.mkdtemp(path.join(process.env.TMPDIR,'fq-recall-')); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'};
 const cfg={dataDir:dir,ownerIds:['1'],memoryBrain:{enabled:true,trustedProcess:true,trustedScope:scope,authorizedSources:['fanqie-ocr']}};
 const directory=path.join(dir,'memory-brain-scoped'); initializeManagedStore(directory);
 const store=createManagedMemoryBrain({directory,scope,sources:['fanqie-ocr'],trustedProcess:true});
 const hash=s=>createHash('sha256').update(s).digest('hex');
 for (const text of ['保留的合成正文','遗忘的合成正文甲','遗忘的合成正文乙','遗忘的合成正文丙']) {
  await saveFanqieMemory(dir,{source:'OCR',text,fingerprint:hash(text),summary:'合成摘要',keywords:['合成']});
  if(text.startsWith('遗忘')) await store.forget(scope,{source:'fanqie-ocr',evidence:'sha256:'+hash(text)});
 }
 const all=await recallFanqie(dir,'最近读了什么小说',{limit:Infinity});
 const filtered=await createFanqieBackgroundFilter(cfg,dir)(all);
 assert.deepEqual(filtered.map(r=>r.text),['保留的合成正文']);
 assert.deepEqual(await createFanqieBackgroundFilter({...cfg,ownerIds:['2']},dir)(all),[]);
});
