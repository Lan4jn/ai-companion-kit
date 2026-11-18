import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {initializeManagedStore,createManagedMemoryBrain} from '../src/memory-brain-trust.js';
import {createBiliBackgroundFilter} from '../src/bili-background-memory.js';
import {__debug} from '../src/bili-living.js';
import {generateDailyDiary} from '../src/diary-system.js';

async function feeling(id, thought) {
 let n=0; const diaryMood=await __debug.summarizeForDiary({reply:async()=>({text:++n===1?JSON.stringify({thought,quote:'人物挥手'}):'{"safe":true}'})},'画面模型观察（0-10秒，可能误识）：人物挥手');
 const samples=Array.from({length:11},(_,i)=>({time:i,wall:i/2,duration:10,rate:2,identity:true,paused:false,seeking:false,ended:i===10}));
 return __debug.buildBiliDiary([{played:true,bvid:id,duration:10,coverage:{complete:true,duration:10,segments:[{start:0,end:10,visual:'人物挥手'}]},playback:{complete:true,fullWatchVerified:true,duration:10,start:0,end:10,watched:10,samples},diaryMood}]);
}
test('background filter uses only validated public video candidates and owner tombstones',async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'bili-background-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'};
 const directory=path.join(dir,'memory-brain-scoped'); initializeManagedStore(directory);
 const store=createManagedMemoryBrain({directory,scope,sources:['bili-observation'],trustedProcess:true});
 await store.forget(scope,{source:'bili-observation',evidence:'https://www.bilibili.com/video/BV11T411P7o2'});
 const cfg={dataDir:dir,ownerIds:['1'],memoryBrain:{enabled:true,trustedProcess:true,trustedScope:scope,authorizedSources:['bili-observation','qq-private-message']}};
 const rows=[await feeling('BV11T411P7o1','我觉得温暖。'),await feeling('BV11T411P7o2','我很难过。'),{category:'私聊',activity:'主人私密信息'}];
 const filter=createBiliBackgroundFilter(cfg,dir);
 assert.deepEqual((await filter(rows)).map(r=>r.biliFeeling.bvid),['BV11T411P7o1']);
 assert.deepEqual(await createBiliBackgroundFilter({...cfg,ownerIds:['2']},dir)(rows),[]);
 assert.deepEqual(await createBiliBackgroundFilter({...cfg,memoryBrain:{...cfg.memoryBrain,trustedProcess:false}},dir)(rows),[]);
 assert.deepEqual(await createBiliBackgroundFilter({...cfg,memoryBrain:{...cfg.memoryBrain,authorizedSources:['qq-private-message']}},dir)(rows),[]);
 assert.deepEqual(await createBiliBackgroundFilter({...cfg,memoryBrain:{...cfg.memoryBrain,trustedScope:{...scope,session:'private:2'}}},dir)(rows),[]);
 fs.writeFileSync(path.join(directory,'.memory-brain-trust'),'review\n');
 assert.deepEqual(await filter(rows),[]);
 fs.rmSync(directory,{recursive:true,force:true});
 assert.deepEqual(await filter(rows),[]);
});

test('background diary and browsing decision use filtered feelings without leaking fields',async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'bili-background-path-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'};
 const directory=path.join(dir,'memory-brain-scoped'); initializeManagedStore(directory);
 const store=createManagedMemoryBrain({directory,scope,sources:['bili-observation'],trustedProcess:true});
 await store.forget(scope,{source:'bili-observation',evidence:'https://www.bilibili.com/video/BV11T411P7o2'});
 const cfg={dataDir:dir,ownerIds:['1'],memoryBrain:{enabled:true,trustedProcess:true,trustedScope:scope,authorizedSources:['bili-observation']}};
 const rows=[await feeling('BV11T411P7o1','我觉得温暖。'),await feeling('BV11T411P7o2','我很难过。')];
 rows[0].details='主人私密信息';
 fs.writeFileSync(path.join(dir,'diary.jsonl'),rows.map(r=>JSON.stringify({...r,t:Date.now()})).join('\n'));
 const filter=createBiliBackgroundFilter(cfg,dir);
 let prompt='';
 await generateDailyDiary({dataDir:dir,biliBackgroundFilter:filter,brain:{reply:async p=>{prompt=p.text;return {text:'# 测试'}}}});
 assert.match(prompt,/我觉得温暖/); assert.doesNotMatch(prompt,/我很难过|主人私密信息/);
 let decision='';
 await __debug.decideBiliBrowsing({complete:async p=>{decision=p.prompt;return '{"want":true}'}},{dir,recentDiary:async()=>rows},{todayCount:0},new AbortController().signal,filter);
 assert.match(decision,/我觉得温暖/); assert.doesNotMatch(decision,/我很难过|主人私密信息/);
});
