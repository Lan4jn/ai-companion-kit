import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transcribeVideoAudio, createOpenAIRecognizer } from '../src/video-audio-transcribe.js';

test('distinguishes no audio track and silence without invoking recognizer', async () => {
  const d = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'audio-test-'));
  try {
    const video=join(d,'video.mp4'), silence=join(d,'silence.wav');
    execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=black:s=32x32:d=1','-an','-y',video]);
    execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','anullsrc=r=16000:cl=mono','-t','1','-y',silence]);
    const recognize=async()=>{ throw Error('must not call'); };
    assert.equal((await transcribeVideoAudio(video,{recognize})).status,'no_audio');
    assert.equal((await transcribeVideoAudio(silence,{recognize})).status,'silence');
  } finally {rmSync(d,{recursive:true,force:true});}
});

test('sound produces bounded timestamped uncertain chunks and reports empty results', async () => {
  const d=mkdtempSync(join(process.env.TMPDIR || tmpdir(),'audio-test-'));
  try {
    const f=join(d,'tone.wav');
    execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:duration=2','-y',f]);
    let count=0;
    const result=await transcribeVideoAudio(f,{chunkSeconds:1,recognize:async()=> (++count===1?'示例':'')});
    assert.equal(result.status,'unreliable');
    assert.deepEqual(result.segments.map(s=>[s.start,s.end,s.reliable,s.error||null]),[[0,1,false,null],[1,2,false,'empty_recognition']]);
    await assert.rejects(transcribeVideoAudio(f,{maxDuration:1,recognize:async()=>''}),/duration/);
  } finally {rmSync(d,{recursive:true,force:true});}
});

test('rejects network inputs and non-http recognizer endpoints', async () => {
  await assert.rejects(transcribeVideoAudio('http://example.com/a',{recognize:async()=>''}),/local/);
  assert.throws(()=>createOpenAIRecognizer({endpoint:'file:///etc/passwd',apiKey:'x',model:'x'}),/endpoint/);
});


test('recognizer failures preserve safe actionable diagnostics without leaking errors', async () => {
  const d=mkdtempSync(join(process.env.TMPDIR || tmpdir(),'audio-test-'));
  try {
    const f=join(d,'tone.wav');
    execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:duration=1','-y',f]);
    const server=(await import('node:http')).createServer((req,res)=>{res.writeHead(429);res.end('secret response');});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    try {
      const recognize=createOpenAIRecognizer({endpoint:`http://127.0.0.1:${server.address().port}/v1/audio/transcriptions`,apiKey:'secret-key',model:'test'});
      const result=await transcribeVideoAudio(f,{recognize});
      assert.equal(result.segments[0].error,'recognition_failed');
      assert.equal(result.segments[0].errorDetail,'http_429');
      assert.ok(!JSON.stringify(result).includes('secret'));
    } finally {await new Promise(resolve=>server.close(resolve));}
  } finally {rmSync(d,{recursive:true,force:true});}
});
