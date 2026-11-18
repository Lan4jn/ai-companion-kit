import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { transcribeVideoAudio, createOpenAIRecognizer } from './video-audio-transcribe.js';

// Sending media to a remote provider requires explicit opt-in and full settings.
export function createBiliAudioRecognizer(config) {
  if (config?.enabled !== true) return null;
  try { return createOpenAIRecognizer(config); } catch { return null; }
}
const run = promisify(execFile);

// The API gives integer seconds; accept its observed ceiling convention only.
// This does not prove file integrity: decoded frames are checked separately.
export function matchesBiliDuration(actual, expected) {
  return Number.isFinite(actual) && actual > 0 && Number.isFinite(expected) && expected > 0 &&
    (Number.isInteger(expected) ? actual > expected - 1 && actual <= expected + 0.05 : Math.abs(actual - expected) <= 0.05);
}

async function videoCoverage(file, duration) {
  const {stdout, stderr} = await run('ffprobe', ['-v','error','-protocol_whitelist','file,pipe','-select_streams','v:0','-show_streams','-show_frames','-show_entries','stream=codec_type,avg_frame_rate:frame=best_effort_timestamp_time,pkt_duration_time','-of','json',file], {timeout:120000,maxBuffer:32*1024*1024});
  if (stderr.trim()) return false;
  const {streams,frames} = JSON.parse(stdout), stream = streams?.[0];
  const [num,den] = String(stream?.avg_frame_rate || '').split('/').map(Number);
  const period = den / num;
  if (stream?.codec_type !== 'video' || !Number.isFinite(period) || period <= 0 || !frames?.length) return false;
  const tolerance = Math.max(0.06, period * 1.5);
  let previous;
  for (const frame of frames) {
    const time = Number(frame.best_effort_timestamp_time);
    if (!Number.isFinite(time) || (previous === undefined ? Math.abs(time) > tolerance : time <= previous || time - previous > tolerance + 0.001)) return false;
    previous = time;
  }
  const packetDuration = Number(frames.at(-1).pkt_duration_time);
  const lastDuration = Number.isFinite(packetDuration) && packetDuration > 0 ? Math.min(packetDuration, period * 1.5) : period;
  return previous + lastDuration >= duration - Math.max(0.06, period * 0.5);
}

export function formatFullEvidence(segments) {
  return '时间片覆盖不等于完整理解，模型可能遗漏或误判。\n' + segments.map(s => `[${s.start}-${s.end}s] 画面：${s.visual}\n字幕：${s.subtitle || '（此段无字幕条目）'}\n音轨机器转写（不保证准确或完整；时间为片段范围）：${s.audio || '（无可用转写，不能推断无语音）'}`).join('\n');
}

// Timed cues establish subtitle availability, not speech completeness.
export async function understandFullVideo({ duration, subtitles, describeSegment, segmentSeconds = 30, allowMissingSubtitles = false }) {
  const result = { complete: false, duration, segments: [], reason: '', subtitlesAvailable: false, audioSpeechComplete: false };
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(segmentSeconds) || segmentSeconds <= 0 || typeof describeSegment !== 'function') {
    result.reason = 'invalid_media_or_model'; return result;
  }
  const cues = (Array.isArray(subtitles) ? subtitles : []).filter(c => Number.isFinite(c.from) && Number.isFinite(c.to) && c.from >= 0 && c.to > c.from && typeof c.content === 'string' && c.content.trim()).sort((a,b) => a.from-b.from);
  if (!cues.length && !allowMissingSubtitles) { result.reason = 'missing_timed_subtitles'; return result; }
  result.subtitlesAvailable = cues.length > 0;
  for (let start = 0; start < duration; start += segmentSeconds) {
    const end = Math.min(duration, start + segmentSeconds);
    let visual;
    try { visual = await describeSegment(start, end); } catch { visual = null; }
    const segment = { start, end, visual: typeof visual === 'string' ? visual.trim() : '', subtitle: cues.filter(c => c.from < end && c.to > start).map(c => `[${c.from}-${c.to}] ${c.content}`).join('\n') };
    result.segments.push(segment);
    if (!segment.visual || /(?:无法|不能|没法|难以).{0,20}(?:确认|判断|辨认|理解|知晓|知道|说明|观看|查看|访问|分析|识别|处理|确定)|(?:cannot|can't|unable to|could not)\s+(?:access|view|watch|see|analy[sz]e|determine|confirm|identify|describe|tell|understand)|无法.{0,8}描述.{0,8}(?:视频|画面|内容)|无法.{0,12}(观看|查看|访问|分析|识别|处理|确定)|不能.{0,12}(观看|查看|访问|分析|识别|处理)|不具备.{0,20}(观看|查看|分析)|只能看到|看不清|(?:抱歉|对不起).{0,30}(?:视频|观看)|(?:内容丰富|值得一看|视频很有趣)|^这是一段视频[。.!！]?\s*$|cannot (?:access|view|watch|see|analy[sz]e)|unable to (?:access|view|watch|see|analy[sz]e)/i.test(segment.visual)) { result.reason = 'segment_analysis_failed'; return result; }
  }
  result.complete = true;
  return result;
}

export async function understandBiliFile({ file, brain, expectedDuration, subtitles, segmentSeconds = 30, recognize, audioChunkSeconds = 20 }) {
  let dir;
  try {
    if (!file || typeof brain?.describeVideo !== 'function' || !Number.isFinite(expectedDuration) || expectedDuration <= 0) return { complete: false, reason: 'missing_media_or_duration', segments: [] };
    const { stdout } = await run('ffprobe', ['-v','error','-show_entries','format=duration:stream=codec_type','-of','json', file], { timeout: 30000 });
    const probe = JSON.parse(stdout);
    const duration = Number(probe.format?.duration);
    if (!probe.streams?.some(s => s.codec_type === 'video') || !matchesBiliDuration(duration, expectedDuration) || !await videoCoverage(file, duration)) return { complete: false, reason: 'media_duration_mismatch', duration, segments: [] };
    dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bili-segments-'));
    const result = await understandFullVideo({ duration, subtitles, segmentSeconds, allowMissingSubtitles: true, describeSegment: async (start, end) => {
      const clip = path.join(dir, `segment-${start}.mp4`);
      await run('ffmpeg', ['-y','-loglevel','error','-ss',String(start),'-i',file,'-t',String(end-start),'-map','0:v:0','-an','-c:v','mpeg4',clip], { timeout: 120000 });
      const clipInfo = JSON.parse((await run('ffprobe', ['-v','error','-show_entries','format=duration:stream=codec_type','-of','json',clip], {timeout:30000})).stdout);
      const clipDuration = Number(clipInfo.format?.duration);
      if (!clipInfo.streams?.some(s=>s.codec_type==='video') || !Number.isFinite(clipDuration) || Math.abs(clipDuration-(end-start)) > Math.max(0.25,(end-start)*0.01) || !await videoCoverage(clip, end-start)) return null;
      return brain.describeVideo(clip, { maxSeconds: end-start + 0.2, prompt: '只描述视频画面中的事件、动作和文字，按顺序说明；不要推断音频。无法观看时明确说明。' });
    } });
    result.audio = { status: probe.streams?.some(s => s.codec_type === 'audio') ? 'not_configured' : 'no_audio', segments: [] };
    if (result.audio.status !== 'no_audio' && typeof recognize === 'function') {
      try { result.audio = await transcribeVideoAudio(file,{recognize,maxDuration:600,chunkSeconds:audioChunkSeconds}); }
      catch { result.audio = {status:'failed',segments:[]}; }
    }
    for (const segment of result.segments) {
      segment.audio = result.audio.segments.filter(s=>s.start < segment.end && s.end > segment.start).map(s=>`[${s.start}-${s.end}s] ${s.text || '（识别失败或无结果）'}`).join('\n');
    }
    return result;
  } catch { return { complete: false, reason: 'media_processing_failed', segments: [] }; }
  finally { if (dir) fs.rmSync(dir, { recursive: true, force: true }); }
}
