import test from 'node:test';
import assert from 'node:assert/strict';
import { understandFullVideo, understandBiliFile } from '../src/bili-full-video.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('covers every segment with both visual and timed subtitle evidence', async () => {
  const calls = [];
  const result = await understandFullVideo({ duration: 65, subtitles: [
    { from: 0, to: 30, content: '一' }, { from: 30, to: 60, content: '二' }, { from: 60, to: 65, content: '三' },
  ], describeSegment: async (start, end) => { calls.push([start,end]); return `画面${start}`; } });
  assert.equal(result.complete, true);
  assert.deepEqual(calls, [[0,30],[30,60],[60,65]]);
  assert.equal(result.segments.length, 3);
});

test('fails closed for missing subtitles or a failed visual segment', async () => {
  const gap = await understandFullVideo({ duration: 60, subtitles: [], describeSegment: async () => '画面' });
  assert.equal(gap.complete, false);
  assert.equal(gap.reason, 'missing_timed_subtitles');
  const broken = await understandFullVideo({ duration: 60, subtitles: [{from: 0, to: 60, content: '台词'}], describeSegment: async start => start === 0 ? '画面' : null });
  assert.equal(broken.complete, false);
  assert.equal(broken.segments.length, 2);
});

test('accepts a grounded static scene when no action can be described', async () => {
  const r = await understandFullVideo({duration: 1, allowMissingSubtitles:true, describeSegment: async () => '整个画面是纯红色，没有人物或文字，因此无法描述具体动作。'});
  assert.equal(r.complete, true);
});

test('rejects error-like video model responses', async () => {
  const r = await understandFullVideo({ duration: 1, subtitles: [{from: 0, to: 1, content: '台词'}], describeSegment: async () => '我无法观看这个视频' });
  assert.equal(r.complete, false);
});

test('production watch path uses full analysis rather than nine-frame sheet', () => {
  const source = readFileSync(new URL('../src/bili-living.js', import.meta.url), 'utf8');
  const watch = source.slice(source.indexOf('async function watchOne('));
  assert.match(watch, /understandBiliFile\(/);
  assert.doesNotMatch(watch.slice(0, watch.indexOf('const seen =')), /makeFrameSheet\(/);
});

test('real ffmpeg segments reach the model without truncation', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bili-test-'));
  try {
    const file = path.join(dir, 'input.mp4');
    execFileSync('ffmpeg', ['-y','-loglevel','error','-f','lavfi','-i','color=c=blue:s=160x120:r=2:d=3','-c:v','mpeg4',file]);
    const lengths = [];
    const brain = { describeVideo: async f => { lengths.push(Number(execFileSync('ffprobe', ['-v','error','-show_entries','format=duration','-of','csv=p=0',f], {encoding:'utf8'}))); return '蓝色画面'; } };
    const r = await understandBiliFile({file, brain, expectedDuration: 3, subtitles: [{from:0,to:3,content:'测试'}], segmentSeconds: 2});
    assert.equal(r.complete, true);
    assert.equal(lengths.length, 2);
    assert.ok(lengths[0] >= 1.9 && lengths[1] >= 0.9);
  } finally { rmSync(dir, {recursive:true,force:true}); }
});

test('rejects refusal and generic model answers even when nonempty', async () => {
  for (const visual of ['抱歉，我目前还不具备直接观看视频的能力。', '这个视频很有趣，内容丰富，值得一看。']) {
    const r = await understandFullVideo({duration: 1, subtitles: [{from:0,to:1,content:'台词'}], describeSegment: async () => visual});
    assert.equal(r.complete, false, visual);
  }
});

test('subtitle gaps do not imply missing evidence or verified audio', async () => {
  const r = await understandFullVideo({duration: 60, subtitles: [{from:2,to:5,content:'你好'},{from:50,to:52,content:'再见'}], describeSegment: async start => `画面${start}`});
  assert.equal(r.complete, true);
  assert.equal(r.subtitlesAvailable, true);
  assert.equal(r.audioSpeechComplete, false);
  assert.equal(r.segments.length, 2);
});

test('all segments must reach downstream context without truncation', async () => {
  const { formatFullEvidence } = await import('../src/bili-full-video.js');
  const segments = Array.from({length: 50}, (_, i) => ({start:i,end:i+1,visual:`画面事件${i}${'甲'.repeat(50)}`,subtitle:`字幕${i}`}));
  const evidence = formatFullEvidence(segments);
  assert.match(evidence, /画面事件49/);
  assert.match(evidence, /字幕49/);
  assert.ok(evidence.length > 2500);
  const source = readFileSync(new URL('../src/bili-living.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /seen\.slice\(0,\s*(?:1800|2000|2500)\)/);
});

test('incomplete model observations do not establish full segment analysis', async () => {
  for (const visual of ['我只能看到开头，后面的内容看不清。', '我无法确定视频中发生了什么。', 'I cannot see the video.', '这是一段视频。']) {
    const r = await understandFullVideo({duration:1, subtitles:[{from:0,to:1,content:'字'}], describeSegment:async () => visual});
    assert.equal(r.complete, false, visual);
  }
});
