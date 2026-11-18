import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { perceiveDouyinFullPage } from '../src/douyin-full-video.js';
import { createDouyinInterestMemory } from '../src/douyin-interest-memory.js';

test('synthetic page media bytes through analysis, decision, persistence and recall', async () => {
 const dir=mkdtempSync(join(tmpdir(),'dy-chain-'));
 try {
  const path=join(dir,'clip.mp4');
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=160x120:rate=10:duration=2','-c:v','libx264','-pix_fmt','yuv420p','-y',path]);
  const bytes=readFileSync(path); let n=0;
  const page={evaluate:async () => {n++; if(n===1) return {identity:true,playing:true,duration:2,time:0,sourceScheme:'http_or_https'}; if(n===2) return {complete:true,start:0,end:2}; if(n===3) return bytes.toString('base64'); if(n===4) return true; throw Error('unexpected');}};
  const brain={describeVideo:async () => '猫在草地上玩耍', complete:async () => ({interested:true,index:0})};
  const p=await perceiveDouyinFullPage(page,brain,{expectedWorkUrl:'https://www.douyin.com/video/123',collectHostObservation:true});
  assert.equal(p.complete,true); assert.equal(p.hostObservation.mediaBytes,bytes.length);
  assert.equal(p.hostObservation.mediaSha256,createHash('sha256').update(bytes).digest('hex'));
  const store=createDouyinInterestMemory({enabled:true,directory:join(dir,'store'),brain});
  assert.equal((await store.consider({...p.hostObservation,processingComplete:p.complete,segments:p.segments})).status,'remembered');
  const [r]=await store.recall('草地'); assert.equal(r.workUrl,'https://www.douyin.com/video/123'); assert.equal(r.identityBinding,'untrusted_page_metadata');
 } finally {rmSync(dir,{recursive:true,force:true});}
});
