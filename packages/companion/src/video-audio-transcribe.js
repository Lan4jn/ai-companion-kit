import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat, mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const run = promisify(execFile);
const execOptions = { timeout: 30000, maxBuffer: 1024 * 1024 };

/** Local files only; never sends audio anywhere except an explicitly supplied recognizer. */
export async function transcribeVideoAudio(path, { recognize, maxDuration = 300, chunkSeconds = 20 } = {}) {
  if (typeof path !== 'string' || path.includes('://')) throw Error('local file required');
  if (typeof recognize !== 'function') throw Error('recognizer required');
  if (!Number.isFinite(maxDuration) || maxDuration <= 0 || maxDuration > 600 || !Number.isFinite(chunkSeconds) || chunkSeconds < 1 || chunkSeconds > 30) throw Error('invalid limits');
  const info = await stat(path);
  if (!info.isFile() || info.size > 100 * 1024 * 1024) throw Error('invalid or oversized input');
  const probe = JSON.parse((await run('ffprobe', ['-v','error','-protocol_whitelist','file,pipe','-show_entries','format=duration:stream=codec_type,duration','-of','json',path],execOptions)).stdout);
  if (!probe.streams?.some(s => s.codec_type === 'audio')) return { status:'no_audio', segments:[] };
  const duration = Number(probe.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > maxDuration) throw Error('unknown or oversized duration');
  const dir = await mkdtemp(join(process.env.TMPDIR || tmpdir(),'video-asr-'));
  try {
    const segments=[]; let sound=false, rateLimited=false;
    for (let start=0; start<duration; start+=chunkSeconds) {
      const end=Math.min(duration,start+chunkSeconds), wav=join(dir,'chunk.wav');
      if (rateLimited) { segments.push({start,end,text:'',reliable:false,error:'recognition_failed',errorDetail:'rate_limited'}); continue; }
      await run('ffmpeg',['-v','error','-nostdin','-threads','1','-protocol_whitelist','file,pipe','-ss',String(start),'-i',path,'-t',String(end-start),'-map','0:a:0','-vn','-ac','1','-ar','16000','-c:a','pcm_s16le','-y',wav],execOptions);
      const buf=await readFile(wav);
      // PCM data begins after ffmpeg's WAV header, locate its data chunk.
      let p=12, data=null;
      while (p+8<=buf.length) { const size=buf.readUInt32LE(p+4); if(buf.toString('ascii',p,p+4)==='data'){data=buf.subarray(p+8,Math.min(buf.length,p+8+size));break;} p+=8+size+(size%2); }
      if (!data || data.length<2) throw Error('empty or invalid decoded audio');
      let sum=0; for(let i=0;i+1<data.length;i+=2){const n=data.readInt16LE(i)/32768;sum+=n*n;}
      if(Math.sqrt(sum/(data.length/2))<0.0001) continue;
      sound=true;
      try {
        const text=await recognize(buf,{start,end});
        if(typeof text==='string' && text.trim()) segments.push({start,end,text:text.trim().slice(0,4000),reliable:false});
        else segments.push({start,end,text:'',reliable:false,error:'empty_recognition'});
      } catch (error) {
        // Never persist raw provider errors: they can contain credentials or media.
        const http = /^recognizer HTTP ([45]\d\d)$/.exec(error?.message || '');
        const errorDetail = http ? `http_${http[1]}` : error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'provider_error';
        if (http?.[1] === '429') rateLimited=true;
        segments.push({start,end,text:'',reliable:false,error:'recognition_failed',errorDetail});
      }
    }
    return {status: sound ? 'unreliable' : 'silence',segments};
  } finally {await rm(dir,{recursive:true,force:true});}
}

/** OpenAI-compatible STT; caller supplies endpoint and key explicitly. */
export function createOpenAIRecognizer({endpoint, apiKey, model, timeoutMs=30000}) {
  let url; try { url = new URL(endpoint); } catch { throw Error('invalid endpoint'); }
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw Error('invalid endpoint');
  if (!apiKey || !model || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60000) throw Error('invalid recognizer settings');
  return async wav => {
    let response;
    for (let attempt=0; attempt<2; attempt++) {
      const form=new FormData(); form.append('model',model); form.append('file',new Blob([wav],{type:'audio/wav'}),'chunk.wav');
      try {
        response=await fetch(endpoint,{method:'POST',headers:{Authorization:`Bearer ${apiKey}`},body:form,signal:AbortSignal.timeout(timeoutMs),redirect:'error'});
      } catch (error) {
        const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
        if (timeout && attempt === 0) continue;
        const safe = new Error(timeout ? 'recognizer timeout' : 'recognizer request failed');
        safe.name = timeout ? 'TimeoutError' : 'Error';
        throw safe;
      }
      if (response.ok) break;
      const status = response.status;
      if (attempt === 0 && [500, 502, 503, 504].includes(status)) { await response.body?.cancel().catch(()=>{}); continue; }
      throw Error(`recognizer HTTP ${status}`);
    }
    const reader=response.body?.getReader(); if (!reader) throw Error('empty response');
    const chunks=[]; let bytes=0;
    try {
      for (;;) { const {done,value}=await reader.read(); if(done) break; bytes+=value.length; if(bytes>65536) throw Error('oversized response'); chunks.push(value); }
    } finally { await reader.cancel().catch(()=>{}); }
    const json=JSON.parse(Buffer.concat(chunks).toString('utf8')); return json.text;
  };
}
