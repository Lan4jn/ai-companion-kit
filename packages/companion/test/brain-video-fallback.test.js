import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Brain } from '../src/brain.js';

test('video channel failure falls back to visionFallback with silent video and safe diagnostics', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'video-test-'));
  const video = path.join(dir, 'sample.mp4');
  execFileSync('ffmpeg', ['-hide_banner','-loglevel','error','-f','lavfi','-i','color=red:s=64x64:d=1','-f','lavfi','-i','sine=frequency=440:duration=1','-shortest','-c:v','libx264','-c:a','aac',video]);
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const logs = [], calls = [];
  console.warn = (...args) => logs.push(args.join(' '));
  globalThis.fetch = async (url, opts) => {
    calls.push({url, opts, body: JSON.parse(opts.body)});
    if (calls.length === 1) throw new Error('private-secret');
    return {ok:true, json:async () => ({choices:[{message:{content:'红色画面'}}]})};
  };
  try {
    const brain = new Brain({ apiKey:'main', role:{}, memory:{}, timeoutMs:30000,
      videoVision:{baseUrl:'https://broken.invalid',apiKey:'private-secret',model:'primary'},
      visionFallback:{baseUrl:'https://fallback.invalid',apiKey:'fallback-secret',model:'fallback'} });
    assert.equal(await brain.describeVideo(video), '红色画面');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].body.model, 'fallback');
    assert.ok(calls[1].opts.signal instanceof AbortSignal);
    const parts = calls[1].body.messages[0].content;
    assert.match(parts[0].text, /(?:无音频|没有音频|不含音频)/);
    assert.ok(parts[1].video_url.url.startsWith('data:video/mp4;base64,'));
    const sent = path.join(dir, 'sent.mp4');
    writeFileSync(sent, Buffer.from(parts[1].video_url.url.split(',')[1], 'base64'));
    const streams = JSON.parse(execFileSync('ffprobe', ['-v','error','-show_entries','stream=codec_type','-of','json',sent], {encoding:'utf8'}));
    assert.deepEqual(streams.streams.map(s => s.codec_type), ['video']);
    assert.match(logs.join(' '), /fallback/i);
    assert.doesNotMatch(logs.join(' '), /private-secret|fallback-secret/);
  } finally { globalThis.fetch = originalFetch; console.warn = originalWarn; rmSync(dir,{recursive:true,force:true}); }
});
