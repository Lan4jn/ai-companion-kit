import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
const run=promisify(execFile);
const LIMIT=100*1024*1024;

// Only media URLs returned by Bilibili's API; never forward account cookies to CDN.
function mediaUrl(value) {
  try { const u=new URL(value); return u.protocol==='https:' && !u.port && (u.hostname.endsWith('.bilivideo.com') || u.hostname.endsWith('.bilivideo.cn')) && !u.username && !u.password; } catch {return false;}
}

// Fail closed on non-global, special-use, mapped and transitional addresses.
const blocked = new net.BlockList();
for (const [address,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) blocked.addSubnet(address,prefix,'ipv4');
for (const [address,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]]) blocked.addSubnet(address,prefix,'ipv6');
function publicAddress(address, family) {
  if (net.isIP(address) !== family) return false;
  if (family === 4) return !blocked.check(address,'ipv4');
  // Only global unicast; excludes mapped IPv4, link-local, ULA, multicast.
  const global = new net.BlockList(); global.addSubnet('2000::',3,'ipv6');
  return global.check(address,'ipv6') && !blocked.check(address,'ipv6');
}

// DNS is resolved exactly once; the socket receives that validated IP through
// lookup, while URL hostname still drives TLS SNI and certificate validation.
export async function secureBiliFetch(value, {lookup=dns.lookup, request=https.request}={}) {
  if (!mediaUrl(value)) throw Error('invalid media host');
  const url = new URL(value);
  const addresses = await lookup(url.hostname,{all:true,verbatim:true});
  if (!Array.isArray(addresses) || !addresses.length || addresses.some(a=>!publicAddress(a.address,a.family))) throw Error('unsafe media address');
  const selected=addresses[0];
  return new Promise((resolve,reject)=>{
    const signal=AbortSignal.timeout(120000);
    const req=request(url, {method:'GET', headers:{referer:'https://www.bilibili.com/', 'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'}, servername:url.hostname, agent:false, signal,
      lookup: (_hostname, options, callback) => {
        if (typeof options === 'function') { callback=options; options={}; }
        if (options?.all) callback(null,[selected]); else callback(null,selected.address,selected.family);
      }}, response=>{
      if (response.statusCode < 200 || response.statusCode >= 300) { response.destroy(); reject(Error('download failed or redirected')); return; }
      resolve({ok:true,body:response});
    });
    req.on('error',reject); req.end();
  });
}
async function probe(file) {
  const {stdout}=await run('ffprobe',['-v','error','-show_entries','format=duration:stream=codec_type,codec_name,duration','-of','json',file],{timeout:30000});
  return JSON.parse(stdout);
}
export async function assembleBiliMedia({data, fetchImpl}) {
  // The injected transport exists solely for isolated node:test fixtures.
  if (fetchImpl && !process.env.NODE_TEST_CONTEXT) throw Error('test transport unavailable');
  const download = fetchImpl || secureBiliFetch;
  const dir=fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(),'bili-media-'));
  let success=false, total=0;
  try {
    const durl=Array.isArray(data?.durl) && data.durl.length ? data.durl : null;
    const dash=data?.dash;
    let entries;
    if(durl) {
      entries=[...durl];
      if(entries.some((e,i)=>e.order != null && Number(e.order)!==i+1)) throw Error('invalid part order');
    } else if(dash?.video?.length && dash?.audio?.length) entries=[dash.video[0],dash.audio[0]];
    else throw Error('no supported media');
    const files=[], durations=[]; let audioPresent, streamSignature;
    for (let i=0;i<entries.length;i++) {
      const e=entries[i], url=e.url || e.baseUrl || e.base_url;
      if(!mediaUrl(url)) throw Error('invalid media host');
      const response=fetchImpl ? await download(url,{headers:{referer:'https://www.bilibili.com/'},redirect:'error',signal:AbortSignal.timeout(120000)}) : await download(url);
      if(!response.ok || !response.body) throw Error('download failed');
      const chunks=[]; let bytes=0;
      for await (const chunk of response.body) { bytes+=chunk.length; total+=chunk.length; if(total>LIMIT) throw Error('media too large'); chunks.push(chunk); }
      if(!bytes || (Number(e.size)>0 && bytes!==Number(e.size))) throw Error('incomplete part');
      const file=path.join(dir,`part-${i}.media`); fs.writeFileSync(file,Buffer.concat(chunks));
      const info=await probe(file), duration=Number(info.format?.duration);
      if(!Number.isFinite(duration) || duration<=0) throw Error('invalid media');
      if(durl && Number(e.length)>0 && Math.abs(duration-Number(e.length)/1000)>Math.max(0.5,Number(e.length)/1000*0.03)) throw Error('part duration mismatch');
      if(durl && !info.streams?.some(s=>s.codec_type==='video')) throw Error('missing video');
      if(durl) {
        const signature=JSON.stringify(info.streams?.map(s=>[s.codec_type,s.codec_name]));
        if(streamSignature !== undefined && signature !== streamSignature) throw Error('incompatible parts');
        streamSignature=signature;
        const present=info.streams?.some(s=>s.codec_type==='audio') || false;
        if(audioPresent !== undefined && audioPresent !== present) throw Error('inconsistent audio');
        audioPresent=present;
        const audio=info.streams?.find(s=>s.codec_type==='audio');
        if(audio && Number.isFinite(Number(audio.duration)) && Math.abs(Number(audio.duration)-duration)>Math.max(0.25,duration*0.01)) throw Error('short audio');
      }
      if(!durl && !info.streams?.some(s=>s.codec_type===(i?'audio':'video'))) throw Error('missing dash stream');
      files.push(file); durations.push(duration);
    }
    if(!durl && Math.abs(durations[0]-durations[1])>Math.max(0.25,Math.max(...durations)*0.01)) throw Error('dash duration mismatch');
    const out=path.join(dir,'assembled.mp4');
    if(durl) {
      const list=path.join(dir,'parts.txt'); fs.writeFileSync(list,files.map(f=>`file '${f}'`).join('\n'));
      await run('ffmpeg',['-y','-v','error','-f','concat','-safe','0','-i',list,'-c','copy',out],{timeout:120000});
    } else await run('ffmpeg',['-y','-v','error','-i',files[0],'-i',files[1],'-map','0:v:0','-map','1:a:0','-c','copy',out],{timeout:120000});
    const assembled=await probe(out), duration=Number(assembled.format?.duration);
    if(!Number.isFinite(duration) || duration<=0 || !assembled.streams?.some(s=>s.codec_type==='video') || (!durl && !assembled.streams?.some(s=>s.codec_type==='audio'))) throw Error('bad output');
    const expected=durl ? durations.reduce((a,b)=>a+b,0) : durations[0];
    if(Math.abs(duration-expected)>Math.max(0.25,expected*0.01)) throw Error('assembled duration mismatch');
    success=true; return out;
  } catch {return null;} finally {if(!success) fs.rmSync(dir,{recursive:true,force:true});}
}
