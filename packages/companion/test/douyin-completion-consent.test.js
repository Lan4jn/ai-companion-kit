import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createDouyinRecognizer, perceiveDouyinFullPage } from '../src/douyin-full-video.js';

test('Whisper configuration alone does not authorize Douyin audio export', async () => {
  const dir=mkdtempSync(join(process.env.TMPDIR || tmpdir(),'dy-consent-'));
  try {
    const config=join(dir,'config.json');
    writeFileSync(config,JSON.stringify({provider:[{type:'openai_whisper_api',enable:true,api_base:'http://127.0.0.1/v1',api_key:'test',model:'test'}]}));
    assert.equal(await createDouyinRecognizer({configPath:config}),undefined);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('partial understanding or unverified playback cannot report full success', async () => {
  const dir=mkdtempSync(join(process.env.TMPDIR || tmpdir(),'dy-partial-'));
  try {
    const file=join(dir,'v.mp4');
    execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=80x60:rate=2:duration=21','-c:v','mpeg4','-y',file]);
    const data=readFileSync(file).toString('base64');
    const run=async (playback, failSecond) => {
      let n=0, described=0;
      const page={evaluate:async()=>{n++; return n===1?{duration:21,time:0,playing:true,identity:true}:n===2?playback:n===3?data:true;}};
      return perceiveDouyinFullPage(page,{describeVideo:async()=> ++described===2 && failSecond ? null : '测试画面'});
    };
    const partial=await run({complete:true},true);
    assert.equal(partial.segments.length,1); assert.equal(partial.complete,false); assert.equal(partial.success,false);
    const unwatched=await run({complete:false,reason:'discontinuous'},false);
    assert.equal(unwatched.complete,true); assert.equal(unwatched.playback.complete,false); assert.equal(unwatched.success,false);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
