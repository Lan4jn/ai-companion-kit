import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {choosePartialBiliFeeling, partialBiliSourceId} from '../src/bili-partial-feeling.js';
import {initializeManagedStore,createManagedMemoryBrain} from '../src/memory-brain-trust.js';
import {createBiliBackgroundFilter} from '../src/bili-background-memory.js';

// The browser/model fixtures are synthetic. A valid-looking replacement in the
// diary must not gain the authority of the selected fragment just by matching its
// own self-derived identifier.
test('background recall rejects coherent replacement of both segment and source identity', async t => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'bili-auth-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'};
 initializeManagedStore(path.join(dir,'memory-brain-scoped'));
 const filter=createBiliBackgroundFilter({dataDir:dir,ownerIds:['1'],memoryBrain:{enabled:true,trustedProcess:true,trustedScope:scope,authorizedSources:['bili-observation']}},dir);
 const samples=Array.from({length:13},(_,i)=>({time:i/2,wall:i/2,duration:20,rate:1,identity:true,seeking:false,paused:false,ended:false,ad:false}));
 const r=await choosePartialBiliFeeling({bvid:'BV1234567890',duration:20,coverage:{duration:20,segments:[{start:0,end:2,visual:'小猫趴窗边'},{start:2,end:5,visual:'小狗跑过'}]},browserResult:{ok:true,skipped:true,watched:6,playback:{samples,interrupted:false}},brain:{complete:async()=>JSON.stringify({interest:'like',start:0,end:2,quote:'小猫',thought:'我喜欢'})}});
 assert.ok(r);
 // A future fix must register this original only from a trusted watchOne path;
 // this synthetic direct call intentionally cannot register an observation.
 const altered=structuredClone(r);
 altered.biliFeeling.evidence.segment={start:2,end:5,visual:'小狗跑过'};
 altered.biliFeeling.quote='小狗';
 altered.biliFeeling.sourceLabel='画面模型观察（2-5秒，可能误识）';
 altered.biliFeeling.sourceId=partialBiliSourceId(altered.biliFeeling.bvid,altered.biliFeeling.evidence.segment);
 const store=createManagedMemoryBrain({directory:path.join(dir,'memory-brain-scoped'),scope,sources:['bili-observation'],trustedProcess:true});
 await store.forget(scope,{source:'bili-observation',evidence:r.biliFeeling.sourceId});
 assert.deepEqual(await filter([altered]),[]);
 // Direct model output is not an authenticated playback record and cannot
 // be registered via the write callback.
 let writes=0;
 assert.deepEqual(await filter([r],async()=>writes++),[]);
 assert.deepEqual(await filter([altered],async()=>writes++),[]);
 assert.equal(writes,0);
 const otherScope={...scope,session:'private:2',user:'2'};
 const otherFilter=createBiliBackgroundFilter({dataDir:dir,ownerIds:['2'],memoryBrain:{enabled:true,trustedProcess:true,trustedScope:otherScope,authorizedSources:['bili-observation']}},dir);
 assert.deepEqual(await otherFilter([r,altered]),[]);
 await store.forget(scope,{source:'bili-observation',evidence:'https://www.bilibili.com/video/BV1234567890'});
 assert.deepEqual(await filter([r,altered]),[]);
 assert.deepEqual(await Promise.all(Array.from({length:8},()=>filter([r],async()=>writes++))),Array.from({length:8},()=>[]));
 assert.equal(writes,0);
});
