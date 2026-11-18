import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { understandBiliFile } from '../src/bili-full-video.js';

test('dense subtitles do not suppress audio transcription', async () => {
  const dir=mkdtempSync(path.join(process.env.TMPDIR || tmpdir(),'bili-evidence-'));
  try {
    const file=path.join(dir,'input.mp4');
    execFileSync('ffmpeg',['-y','-loglevel','error','-f','lavfi','-i','color=s=160x120:r=10:d=2','-f','lavfi','-i','sine=frequency=440:duration=2','-c:v','mpeg4','-c:a','aac','-shortest',file]);
    let calls=0;
    const r=await understandBiliFile({file,expectedDuration:2,subtitles:[{from:0,to:2,content:'字幕'}],brain:{describeVideo:async()=> '蓝色画面'},recognize:async()=>{calls++;return '语音';}});
    assert.ok(calls>0);
    assert.equal(r.audio.status,'unreliable');
    assert.equal(r.audioSpeechComplete,false);
  } finally {rmSync(dir,{recursive:true,force:true});}
});


test('downloads and concatenates every progressive part in order and rejects missing bytes', async () => {
  const { assembleBiliMedia } = await import('../src/bili-media-download.js');
  const dir=mkdtempSync(path.join(process.env.TMPDIR || tmpdir(),'bili-parts-'));
  try {
    const parts=[];
    for (const color of ['red','blue']) {
      const f=path.join(dir,`${color}.mp4`);
      execFileSync('ffmpeg',['-y','-loglevel','error','-f','lavfi','-i',`color=c=${color}:s=160x120:r=10:d=1`,'-c:v','mpeg4',f]);
      parts.push(readFileSync(f));
    }
    const get=async url=>new Response(parts[url.endsWith('red')?0:1]);
    const list=parts.map((p,i)=>({url:`https://test.bilivideo.com/${i?'blue':'red'}`,size:p.length,length:1000,order:i+1}));
    const out=await assembleBiliMedia({data:{durl:list},fetchImpl:get});
    try { assert.ok(out); const duration=Number(execFileSync('ffprobe',['-v','error','-show_entries','format=duration','-of','csv=p=0',out],{encoding:'utf8'})); assert.ok(duration>=1.9); }
    finally { if(out) rmSync(path.dirname(out),{recursive:true,force:true}); }
    list[1].size++;
    assert.equal(await assembleBiliMedia({data:{durl:list},fetchImpl:get}),null);
  } finally {rmSync(dir,{recursive:true,force:true});}
});


test('sliced clips must match their requested time range before reaching the model', async () => {
  const dir=mkdtempSync(path.join(process.env.TMPDIR || tmpdir(),'bili-short-'));
  try {
    const file=path.join(dir,'input.mp4');
    execFileSync('ffmpeg',['-y','-loglevel','error','-f','lavfi','-i','color=s=160x120:r=10:d=2','-c:v','mpeg4',file]);
    const r=await understandBiliFile({file,expectedDuration:3.5,segmentSeconds:1,brain:{describeVideo:async()=> '蓝色画面'}});
    assert.equal(r.complete,false);
  } finally {rmSync(dir,{recursive:true,force:true});}
});


test('DASH video and audio are both muxed and truncated audio is rejected', async () => {
  const {assembleBiliMedia}=await import('../src/bili-media-download.js');
  const dir=mkdtempSync(path.join(process.env.TMPDIR || tmpdir(),'bili-dash-'));
  try {
    const v=path.join(dir,'v.mp4'), a=path.join(dir,'a.m4a'), short=path.join(dir,'short.m4a');
    execFileSync('ffmpeg',['-y','-loglevel','error','-f','lavfi','-i','color=s=160x120:r=10:d=3','-c:v','mpeg4',v]);
    for (const [file,d] of [[a,3],[short,1]]) execFileSync('ffmpeg',['-y','-loglevel','error','-f','lavfi','-i',`sine=duration=${d}`,'-c:a','aac',file]);
    let audio=readFileSync(a); const video=readFileSync(v);
    const fetchImpl=async url=>new Response(url.endsWith('/v')?video:audio);
    const data={dash:{video:[{baseUrl:'https://test.bilivideo.com/v'}],audio:[{baseUrl:'https://test.bilivideo.com/a'}]}};
    const out=await assembleBiliMedia({data,fetchImpl});
    try {assert.ok(out); const p=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','stream=codec_type','-of','json',out],{encoding:'utf8'}));assert.ok(p.streams.some(s=>s.codec_type==='audio'));}
    finally {if(out) rmSync(path.dirname(out),{recursive:true,force:true});}
    audio=readFileSync(short);
    assert.equal(await assembleBiliMedia({data,fetchImpl}),null);
  } finally {rmSync(dir,{recursive:true,force:true});}
});


test('progressive parts with inconsistent audio fail closed', async () => {
 const {assembleBiliMedia}=await import('../src/bili-media-download.js');
 const dir=mkdtempSync(path.join(process.env.TMPDIR || tmpdir(),'bili-audio-parts-'));
 try {
  const a=path.join(dir,'a.mp4'), b=path.join(dir,'b.mp4');
  execFileSync('ffmpeg',['-y','-loglevel','error','-f','lavfi','-i','color=s=160x120:r=10:d=1','-f','lavfi','-i','sine=duration=1','-c:v','mpeg4','-c:a','aac','-shortest',a]);
  execFileSync('ffmpeg',['-y','-loglevel','error','-f','lavfi','-i','color=s=160x120:r=10:d=1','-c:v','mpeg4',b]);
  const blobs=[readFileSync(a),readFileSync(b)];
  assert.equal(await assembleBiliMedia({data:{durl:blobs.map((x,i)=>({url:`https://test.bilivideo.com/${i}`,size:x.length,length:1000}))},fetchImpl:async url=>new Response(blobs[Number(url.at(-1))])}),null);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
