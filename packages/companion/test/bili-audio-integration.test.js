import test from 'node:test';
import assert from 'node:assert/strict';
import { understandBiliFile, formatFullEvidence, createBiliAudioRecognizer } from '../src/bili-full-video.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('sparse subtitles trigger real audio chunk extraction and aligned uncertain ASR', async () => {
  const dir=mkdtempSync(join(process.env.TMPDIR || tmpdir(),'bili-asr-test-'));
  try {
    const file=join(dir,'input.mp4');
    execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=blue:s=32x32:r=2:d=4','-f','lavfi','-i','sine=frequency=440:duration=4','-c:v','mpeg4','-c:a','aac','-shortest','-y',file]);
    const calls=[];
    const result=await understandBiliFile({file,expectedDuration:4,segmentSeconds:2,subtitles:[{from:0,to:1,content:'字幕'}],brain:{describeVideo:async()=> '蓝色画面'},recognize:async (wav,range)=>{assert.equal(wav.toString('ascii',0,4),'RIFF'); calls.push(range); return '识别内容';},audioChunkSeconds:2});
    assert.equal(result.complete,true);
    assert.equal(result.audioSpeechComplete,false);
    assert.deepEqual(calls.map(x=>x.start),[0,2]);
    assert.match(result.segments[1].audio,/识别内容/);
    assert.match(formatFullEvidence(result.segments),/转写.*不保证准确/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('recognizer requires explicit consent and complete configuration', () => {
  const cfg={endpoint:'https://example.com/v1/audio/transcriptions',apiKey:'test-key',model:'test-model'};
  assert.equal(createBiliAudioRecognizer(cfg), null);
  assert.equal(createBiliAudioRecognizer({...cfg, enabled:true, apiKey:''}), null);
  assert.equal(typeof createBiliAudioRecognizer({...cfg,enabled:true}), 'function');
});

test('production memory identifies actual ASR text as an audio source', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/bili-living.js', import.meta.url), 'utf8');
  const watch = source.slice(source.indexOf('async function watchOne('));
  assert.match(watch, /if\s*\(coverage\.audio\?\.segments\?\.some\(s\s*=>\s*typeof s\.text === 'string' && s\.text\.trim\(\)\)\)\s*sources\.push\('audio'\)/);
});

 test('production watch passes an explicitly configured recognizer', async () => {
  const { readFileSync } = await import('node:fs');
  const source=readFileSync(new URL('../src/bili-living.js',import.meta.url),'utf8');
  const watch=source.slice(source.indexOf('async function watchOne('));
  assert.match(watch,/understandBiliFile\(\{[^}]*recognize:/);
 });
