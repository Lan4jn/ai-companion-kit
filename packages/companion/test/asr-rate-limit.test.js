import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createOpenAIRecognizer, transcribeVideoAudio } from '../src/video-audio-transcribe.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('429 stops requests across the entire media, preserving skipped chunks', async () => {
  let calls=0;
  const server=createServer((req,res)=>{calls++; req.resume(); res.writeHead(429,{'Retry-After':'120'}); res.end();});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const dir=mkdtempSync(join(process.env.TMPDIR || tmpdir(),'asr-429-'));
  try {
    const file=join(dir,'tone.wav');
    execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:duration=3','-y',file]);
    const recognize=createOpenAIRecognizer({endpoint:`http://127.0.0.1:${server.address().port}/v1/audio/transcriptions`,apiKey:'test',model:'test'});
    const result=await transcribeVideoAudio(file,{chunkSeconds:1,recognize});
    assert.equal(calls,1);
    assert.equal(result.segments[0].errorDetail,'http_429');
    assert.equal(result.segments.length,3);
    assert.equal(result.segments[1].errorDetail,'rate_limited');
    assert.equal(result.segments[2].errorDetail,'rate_limited');
  } finally {await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
});
