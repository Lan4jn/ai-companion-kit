import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { understandDouyinFile, perceiveDouyinFullPage } from '../src/douyin-full-video.js';

test('10秒容器只有1秒视频轨不可判全片', async () => {
  const dir=mkdtempSync(join(process.env.TMPDIR || tmpdir(),'dy-adversarial-'));
  try {
    const file=join(dir,'short-video.mp4');
    execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=160x120:rate=10:duration=1','-f','lavfi','-i','sine=duration=10','-c:v','mpeg4','-c:a','aac','-y',file]);
    let calls=0;
    const result=await understandDouyinFile({file,duration:10,segmentSeconds:2,brain:{describeVideo:async()=>{calls++;return '画面';}}});
    assert.equal(result.complete,false);
    assert.ok(calls<5);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('身份不明确的网页视频不得视为完整观看', async () => {
  let calls=0;
  const result=await perceiveDouyinFullPage({evaluate:async()=>{calls++;return {duration:10,time:0,playing:true};}}, {describeVideo:async()=> '画面'});
  assert.equal(result.success,false);
  assert.equal(result.complete,false);
  assert.equal(calls,1);
});
