import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {understandBiliFile} from '../src/bili-full-video.js';
import {__debug} from '../src/bili-living.js';

test('integer metadata may round up but decoded video must reach the actual timeline', async () => {
 const dir=mkdtempSync(join(process.env.TMPDIR || tmpdir(),'bili-round-'));
 try {
  const file=join(dir,'full.mp4');
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=blue:s=32x32:r=25:d=2.2','-c:v','mpeg4','-y',file]);
  const brain={describeVideo:async ()=>'蓝色画面'};
  const coverage=await understandBiliFile({file,brain,expectedDuration:3});
  assert.equal(coverage.complete,true,JSON.stringify(coverage));
  const p={ok:true,watched:2.2,playback:{complete:true,start:0,end:2.2,duration:2.2,samples:Array.from({length:12},(_,i)=>({time:i/5,wall:i/10,duration:2.2,rate:2,identity:true,paused:false,seeking:false,ended:i===11}))}};
  assert.equal((await __debug.verifyFullWatch({coverage,expectedDuration:3,browserWatch:async()=>p})).complete,true);
  assert.equal((await __debug.verifyFullWatch({coverage:{...coverage,segments:[{start:0,end:1.5,visual:'蓝'}]},expectedDuration:3,browserWatch:async()=>p})).complete,false);
  const broken=join(dir,'missing-tail.mp4');
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=blue:s=32x32:r=25:d=1.5','-f','lavfi','-i','sine=frequency=440:duration=2.2','-c:v','mpeg4','-c:a','aac','-y',broken]);
  const invalid=await understandBiliFile({file:broken,brain,expectedDuration:3});
  assert.equal(invalid.complete,false,JSON.stringify(invalid));
 } finally {rmSync(dir,{recursive:true,force:true});}
});
