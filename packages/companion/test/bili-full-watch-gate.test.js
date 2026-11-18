import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { understandBiliFile } from '../src/bili-full-video.js';
import { __debug } from '../src/bili-living.js';

test('full processing and browser playback independently gate post-watch flow', async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'bili-gate-'));
  try {
    const file = join(dir, 'synthetic.mp4');
    execFileSync('ffmpeg', ['-v','error','-f','lavfi','-i','color=blue:s=32x32:r=2:d=4','-c:v','mpeg4','-y',file]);
    const coverage = await understandBiliFile({file, expectedDuration:4, segmentSeconds:2, subtitles:[], brain:{describeVideo:async () => '蓝色画面'}});
    assert.equal(coverage.complete, true);
    const partial = {ok:true, watched:2, duration:4, playback:{complete:false}};
    const complete = {ok:true, watched:4, duration:4, playback:{complete:true,start:0,end:4,duration:4,samples:Array.from({length:9},(_,i)=>({time:i/2,wall:i/4,duration:4,rate:2,identity:true,paused:false,seeking:false,ended:i===8}))}};
    const run = async (playback, processed=coverage) => __debug.verifyFullWatch({coverage:processed, expectedDuration:4, browserWatch:async () => playback});
    assert.equal((await run(partial)).complete, false);
    assert.equal((await run(complete, {...coverage,complete:false})).complete, false);
    assert.equal((await run({...complete, playback:{...complete.playback,duration:2}})).complete, false);
    assert.equal((await run(complete, {...coverage,segments:coverage.segments.slice(1)})).complete, false);
    assert.equal((await run(complete)).complete, true);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
