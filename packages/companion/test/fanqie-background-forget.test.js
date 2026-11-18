import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import * as startup from '../src/fanqie-startup.js';
import {initializeManagedStore,createManagedMemoryBrain} from '../src/memory-brain-trust.js';

const hash = text => createHash('sha256').update(text).digest('hex');
test('autonomous willingness filters native reading evidence per owner and fails closed', async t => {
 const dir=await fs.mkdtemp(path.join(process.env.TMPDIR,'fq-forget-')); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'};
 const cfg={dataDir:dir,ownerIds:['1'],memoryBrain:{enabled:true,trustedProcess:true,trustedScope:scope,authorizedSources:['fanqie-ocr']}};
 const directory=path.join(dir,'memory-brain-scoped'); initializeManagedStore(directory);
 const texts=['合成遗忘阅读甲','合成保留阅读乙'];
 const rows=texts.map(text=>({source:'OCR',text,fingerprint:hash(text)}));
 rows.push({source:'OCR',text:'合成伪造阅读丙',fingerprint:hash('其他内容')});
 await fs.writeFile(path.join(dir,'fanqie-reading.jsonl'),rows.map(JSON.stringify).join('\n')+'\n');
 await createManagedMemoryBrain({directory,scope,sources:['fanqie-ocr'],trustedProcess:true}).forget(scope,{source:'fanqie-ocr',evidence:'sha256:'+hash(texts[0])});
 const old=process.env.PHONE_SERIAL; process.env.PHONE_SERIAL='fixture'; t.after(()=>{if(old===undefined)delete process.env.PHONE_SERIAL;else process.env.PHONE_SERIAL=old});
 let prompt,want; const brain={complete:async r=>{prompt=r.prompt;return '{"want":false}'}};
 const run=async filter=>{const handle=startup.startFanqieAutonomous({enabled:true,serial:'fixture',dataDir:dir,brain,historyFilter:filter,mutex:{tryBackground:async()=>false},createIntegration:o=>{want=o.want;return {scheduler:{start(){},stop(){}}}}}); await want(); await handle.stop(); return prompt;};
 const filter= startup.createFanqieBackgroundFilter?.(cfg,dir);
 let result=await run(filter); assert.doesNotMatch(result,/合成遗忘阅读甲|合成伪造阅读丙/); assert.match(result,/合成保留阅读乙/);
 result=await run(startup.createFanqieBackgroundFilter({...cfg,ownerIds:['2']},dir)); assert.doesNotMatch(result,/合成.*阅读/);
 result=await run(async()=>{throw new Error('offline')}); assert.doesNotMatch(result,/合成.*阅读/);
 result=await run(null); assert.doesNotMatch(result,/合成.*阅读/);
 assert.equal((await fs.readFile(path.join(dir,'fanqie-reading.jsonl'),'utf8')).trim().split('\n').length,3);
});
