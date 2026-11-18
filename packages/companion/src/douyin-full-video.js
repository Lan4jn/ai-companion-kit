import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { transcribeVideoAudio, createOpenAIRecognizer } from './video-audio-transcribe.js';

// A general-purpose STT provider does not authorize exporting Douyin audio.
export async function createDouyinRecognizer({ configPath = '/root/data/cmd_config.json' } = {}) {
  try {
    const config = JSON.parse((await readFile(configPath, 'utf8')).replace(/^\uFEFF/, ''));
    if (config.douyin?.allowAudioTranscription !== true) return undefined;
    const provider = config.provider?.find(p => p.type === 'openai_whisper_api' && p.enable === true);
    if (!provider || typeof provider.api_base !== 'string' || typeof provider.api_key !== 'string' || typeof provider.model !== 'string') return undefined;
    // The configured Gemini gateway source supersedes the STT provider's stale host,
    // but only when it is enabled and explicitly uses exactly the same credential.
    const source = config.provider_sources?.find(s => s.id === 'google_gemini_openai' && s.enable === true && s.api_key === provider.api_key && typeof s.api_base === 'string');
    const base = new URL(source?.api_base || provider.api_base);
    if (base.username || base.password || base.search || base.hash) return undefined;
    base.pathname = `${base.pathname.replace(/\/+$/, '')}/audio/transcriptions`;
    return createOpenAIRecognizer({endpoint:base.href, apiKey:provider.api_key, model:provider.model});
  } catch { return undefined; }
}
const run = promisify(execFile);
const invalid = /无法.{0,12}(观看|查看|访问|分析|识别|处理)|不能.{0,12}(观看|查看|访问|分析|识别|处理)|看不清|只能看到|cannot (?:access|view|watch|see|analy[sz]e)|unable to (?:access|view|watch|see|analy[sz]e)/i;

// Require decoded video frames covering the entire timeline, not container/audio duration.
async function videoCoverage(file, duration) {
  const {stdout, stderr} = await run('ffprobe', ['-v','error','-protocol_whitelist','file,pipe','-select_streams','v:0','-show_streams','-show_frames','-show_entries','stream=codec_type,duration,start_time,avg_frame_rate:frame=best_effort_timestamp_time,pkt_duration_time','-of','json',file], {timeout:120000,maxBuffer:32*1024*1024});
  if (stderr.trim()) return false;
  const probe=JSON.parse(stdout), stream=probe.streams?.[0], frames=probe.frames;
  if (stream?.codec_type !== 'video' || !Array.isArray(frames) || !frames.length) return false;
  const [num,den]=String(stream.avg_frame_rate || '').split('/').map(Number);
  const period=den > 0 && num > 0 ? den/num : NaN;
  if (!Number.isFinite(period) || period <= 0 || period > 0.5) return false;
  const tolerance=Math.min(0.5,Math.max(0.12,period*1.5));
  const streamDuration=Number(stream.duration), streamStart=Number(stream.start_time);
  if (!Number.isFinite(streamDuration) || streamDuration < duration-tolerance || !Number.isFinite(streamStart) || Math.abs(streamStart)>tolerance) return false;
  let previous;
  for (const frame of frames) {
    const time=Number(frame.best_effort_timestamp_time);
    if (!Number.isFinite(time) || (previous !== undefined && (time <= previous || time-previous > tolerance))) return false;
    if (previous === undefined && Math.abs(time)>tolerance) return false;
    previous=time;
  }
  const lastDuration=Number(frames.at(-1).pkt_duration_time);
  return previous + (Number.isFinite(lastDuration) && lastDuration > 0 ? Math.min(lastDuration,period*1.5) : period) >= duration-tolerance;
}

// Local media only. recognize(wavBuffer, {start,end}) is optional; transcription is unverified.
export async function understandDouyinFile({ file, duration, brain, recognize, segmentSeconds = 20 }) {
  const r = { complete: false, duration, segments: [], frames: [], reason: '', audio: { status: 'not_configured', segments: [] } };
  if (typeof brain?.describeVideo !== 'function' || !Number.isFinite(duration) || duration <= 0 || duration > 600 || !Number.isFinite(segmentSeconds) || segmentSeconds <= 0 || segmentSeconds > 30) { r.reason = 'invalid_media_or_model'; return r; }
  let dir;
  try {
    const probe = JSON.parse((await run('ffprobe', ['-v','error','-protocol_whitelist','file,pipe','-show_entries','format=duration:stream=codec_type','-of','json',file], { timeout: 30000 })).stdout);
    const actual = Number(probe.format?.duration);
    if (!probe.streams?.some(s => s.codec_type === 'video') || !Number.isFinite(actual) || Math.abs(actual-duration) > Math.max(1, duration*0.02) || !await videoCoverage(file,duration)) { r.reason='media_duration_mismatch'; return r; }
    dir = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'douyin-video-'));
    for (let start=0; start<duration; start+=segmentSeconds) {
      const end=Math.min(duration,start+segmentSeconds), clip=join(dir, 'segment.mp4');
      await run('ffmpeg',['-v','error','-xerror','-nostdin','-threads','1','-protocol_whitelist','file,pipe','-ss',String(start),'-i',file,'-t',String(end-start),'-map','0:v:0','-an','-c:v','mpeg4','-y',clip],{timeout:120000});
      if (!await videoCoverage(clip,end-start)) { r.reason='segment_video_incomplete'; return r; }
      let visual='';
      try { visual=await brain.describeVideo(clip,{maxSeconds:end-start+0.1,prompt:'按时间顺序描述本段画面及可见文字，不推测声音；不能观看请明确说明。'}); } catch {}
      if (typeof visual !== 'string' || !visual.trim() || invalid.test(visual)) { r.reason='segment_analysis_failed'; return r; }
      r.segments.push({start,end,visual:visual.trim()});
    }
    r.complete=true;
  } catch { r.reason='media_processing_failed'; }
  finally { if (dir) await rm(dir,{recursive:true,force:true}); }
  if (typeof recognize === 'function') {
    try { r.audio=await transcribeVideoAudio(file,{recognize,maxDuration:600}); } catch { r.audio={status:'failed',segments:[]}; }
  } else if (r.complete) r.audio={status:'not_configured',segments:[]};
  return r;
}

// Capture the actual browser source; no network URL is passed to ffmpeg.
export async function perceiveDouyinFullPage(page, brain, { recognize, expectedWorkUrl, restartFromBeginning = false, collectHostObservation = false } = {}) {
  let dir;
  try {
    const expectedId = typeof expectedWorkUrl === 'string' ? new URL(expectedWorkUrl).pathname.match(/\/(?:video|note)\/(\d+)(?:\/|$)/)?.[1] : null;
    let workUrl = null;
    try {
      const u = new URL(expectedWorkUrl);
      if (u.protocol === 'https:' && ['www.douyin.com','douyin.com'].includes(u.hostname) && !u.username && !u.password && !u.port && /^\/video\/\d{1,32}\/?$/.test(u.pathname)) workUrl = `https://www.douyin.com/video/${expectedId}`;
    } catch {}
    const initial=await page.evaluate(({expectedId}) => {
      const id=location.pathname.match(/\/(?:video|note)\/(\d+)(?:\/|$)/)?.[1];
      const videos=[...document.querySelectorAll('video')], v=videos[0], src=v?.currentSrc || v?.src;
      if (!id || id !== expectedId || videos.length !== 1 || !src || /uuu_265\.mp4/i.test(src)) return {};
      // The page's work metadata must explicitly associate this exact player URL
      // (or its video_id) with this aweme. A page URL alone is not identity proof.
      let srcId; try { srcId=new URL(src).searchParams.get('video_id'); } catch {}
      const seen=new WeakSet(); let matched=false, visited=0;
      function visit(obj, depth) {
        if (!obj || typeof obj !== 'object' || seen.has(obj) || depth>30 || ++visited>100000) return;
        seen.add(obj);
        if (String(obj.aweme_id || '') === id && obj.video && typeof obj.video === 'object') {
          const contains=(x, d=0) => {
            if (d>20 || x == null) return false;
            if (typeof x === 'string') return x === src || !!srcId && (x === srcId || (()=>{try{return new URL(x).searchParams.get('video_id') === srcId;}catch{return false;}})());
            return typeof x === 'object' && Object.values(x).some(y=>contains(y,d+1));
          };
          if (contains(obj.video)) matched=true;
        }
        for (const x of Object.values(obj)) visit(x,depth+1);
      }
      visit(window._ROUTER_DATA,0);
      if (!matched) return {};
      window.__douyinEvidence={v,src,id,href:location.href};
      return {duration:v.duration,time:v.currentTime,playing:!v.paused && !v.ended && v.readyState>=2, identity:true, sourceScheme:src.startsWith('blob:') ? 'blob' : 'http_or_https'};
    }, {expectedId});
    if (!initial.identity || (!initial.playing && !restartFromBeginning) || !Number.isFinite(initial.duration) || initial.duration<=0 || initial.duration>600) return {success:false,reason:'视频身份、播放状态或时长不可确认',complete:false,frames:[]};
    // Playback observation is independent of media/model processing.
    const playbackStarted = performance.now();
    const playbackPromise=page.evaluate(async ({duration, start, restartFromBeginning}) => {
      const evidence=window.__douyinEvidence, v=evidence?.v;
      if (!v || document.querySelector('video') !== v || (v.currentSrc || v.src) !== evidence.src || location.href !== evidence.href) return {complete:false,reason:'identity_changed'};
      if (restartFromBeginning) {
        v.pause();
        v.currentTime=0;
        if (v.seeking) await new Promise((resolve,reject) => {
          const timer=setTimeout(()=>reject(Error('seek timeout')),5000);
          v.addEventListener('seeked',()=>{clearTimeout(timer);resolve();},{once:true});
        });
        start=v.currentTime;
      }
      if (start>1.5) return {complete:false,reason:'missed_start_or_identity_changed'};
      return await new Promise(resolve => {
        let last=v.currentTime, lastWall=performance.now(), failed=false;
        const onChange=() => { failed=true; };
        const events=['seeking','ratechange','emptied','loadstart'];
        for (const event of events) v.addEventListener(event,onChange);
        const finish=(reason, complete=false) => { clearInterval(timer); for (const event of events) v.removeEventListener(event,onChange); resolve({complete,reason, start, end:v.currentTime}); };
        const deadline=performance.now()+(duration+30)*1000;
        const timer=setInterval(() => {
          const now=performance.now(), t=v.currentTime, delta=t-last, elapsed=(now-lastWall)/1000;
          if (!v.isConnected || document.querySelectorAll('video').length !== 1 || document.querySelector('video') !== v || (v.currentSrc || v.src) !== evidence.src || location.href !== evidence.href || Math.abs(v.duration-duration)>0.05 || v.seeking || v.paused && !v.ended || delta < -0.25 || delta > elapsed*1.8+0.5 || v.playbackRate !== 1) failed=true;
          last=t; lastWall=now;
          if (failed) finish('discontinuous');
          else if ((v.ended || t >= duration-0.15) && t >= duration-0.15) finish('',true);
          else if (now>deadline) finish('timeout');
        },250);
        if (restartFromBeginning) v.play().catch(() => finish('play_failed'));
      });
    }, {duration:initial.duration,start:initial.time,restartFromBeginning}).catch(() => ({complete:false,reason:'observation_failed'})).then(playback => ({playback, hostElapsedMs:performance.now()-playbackStarted}));
    const data=await page.evaluate(async () => {
      const evidence=window.__douyinEvidence, v=evidence?.v, src=evidence?.src;
      if (!v || document.querySelectorAll('video').length !== 1 || document.querySelector('video') !== v || (v.currentSrc || v.src) !== src || location.href !== evidence.href || !src || !/^(blob:|https?:)/i.test(src)) throw Error('source unavailable');
      const response=await fetch(src,{credentials:'same-origin'});
      if (!response.ok || !response.body) throw Error('source unavailable');
      const reader=response.body.getReader(), parts=[]; let size=0;
      try { for (;;) { const {done,value}=await reader.read(); if(done) break; size+=value.length; if(size>100*1024*1024) throw Error('oversized'); parts.push(value); } } finally { await reader.cancel().catch(()=>{}); }
      const blob=new Blob(parts); return await new Promise((resolve,reject) => {const r=new FileReader();r.onload=()=>resolve(String(r.result).split(',')[1]);r.onerror=reject;r.readAsDataURL(blob);});
    });
    dir=await mkdtemp(join(process.env.TMPDIR || tmpdir(),'douyin-source-'));
    const mediaBytes = Buffer.from(data,'base64');
    const capturedAt = new Date().toISOString();
    const mediaSha256 = createHash('sha256').update(mediaBytes).digest('hex');
    const file=join(dir,'source'); await writeFile(file,mediaBytes);
    const [understanding, timedPlayback]=await Promise.all([understandDouyinFile({file,duration:initial.duration,brain,recognize}),playbackPromise]);
    const {playback, hostElapsedMs} = timedPlayback;
    const identityStillValid=await page.evaluate(() => { const e=window.__douyinEvidence, v=e?.v; return !!v && v.isConnected && document.querySelectorAll('video').length===1 && document.querySelector('video')===v && (v.currentSrc || v.src)===e.src && location.href===e.href; });
    // These are diagnostics, not an attestation: page JS controls the source,
    // playback report and refetch. The monotonic interval is only host elapsed time.
    const hostObservation = collectHostObservation === true && mediaBytes.length > 0 ? {
      workId: expectedId, workUrl, identityBinding:'untrusted_page_metadata',
      mediaSource:'page_reported_refetch', sourceScheme:initial.sourceScheme,
      mediaBytes:mediaBytes.length, mediaSha256, capturedAt, hostElapsedMs, reportedPlayback:playback,
      disclaimer:'Not proof of human viewing, actual playback, content authenticity, or media-to-work identity.'
    } : undefined;
    return {...understanding, playback, ...(hostObservation ? {hostObservation} : {}), success:understanding.complete === true && playback.complete === true && identityStillValid === true, complete:understanding.complete === true && identityStillValid === true, frames:understanding.segments.map(s=>({time:s.start,description:`${s.start}-${s.end}秒：${s.visual}`}))};
  } catch { return {success:false,complete:false,frames:[],reason:'无法获取完整视频源或处理失败',playback:{complete:false,reason:'not_verified'}}; }
  finally { if(dir) await rm(dir,{recursive:true,force:true}); }
}
