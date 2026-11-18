import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {saveKnowledge, recallKnowledge} from '../src/bili-living.js';

test('malformed BV cannot fall back to a long exact matching title', t => {
 const old = process.env.HOME;
 const home = fs.mkdtempSync(path.join(process.env.TMPDIR, 'bili-bv-isolation-'));
 process.env.HOME = home;
 t.after(() => { process.env.HOME = old; fs.rmSync(home, {recursive:true, force:true}); });
 const duration = 10;
 const evidence = {version:2, sources:['visual'], coverage:{complete:true,duration,segments:[{start:0,end:10,visual:'企鹅跳舞'}]}, playback:{complete:true,fullWatchVerified:true,duration,start:0,end:10,watched:10,samples:Array.from({length:11},(_,i)=>({time:i,wall:i/2,duration,rate:2,identity:true,paused:false,seeking:false,ended:i===10}))}};
 const title = '木星养企鹅的奇妙故事和雪山上的冒险旅行';
 assert.ok(saveKnowledge({bvid:'BV11T411P7o1',title,duration},{points:[{source:'visual',start:0,end:10,quote:'企鹅跳舞'}]},evidence));
 assert.deepEqual(recallKnowledge(`BV123 ${title}`), []);
});
