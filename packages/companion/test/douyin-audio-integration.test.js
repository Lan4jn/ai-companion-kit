import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createDouyinRecognizer, understandDouyinFile } from '../src/douyin-full-video.js';

test('configured production recognizer transcribes the actual extracted video audio', async () => {
  const dir=mkdtempSync(join(process.env.TMPDIR || tmpdir(),'dy-asr-test-'));
  const calls=[];
  const server=http.createServer(async (req,res) => {
    const chunks=[]; for await (const c of req) chunks.push(c);
    calls.push({url:req.url, authorization:req.headers.authorization, data:Buffer.concat(chunks)});
    res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify({text:'合成测试声音'}));
  });
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const config=join(dir,'config.json');
    writeFileSync(config,JSON.stringify({douyin:{allowAudioTranscription:true},provider:[{type:'openai_whisper_api',enable:true,api_base:`http://127.0.0.1:${server.address().port}/v1`,api_key:'test-key',model:'test-model'}]}));
    const file=join(dir,'video.mp4');
    execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=160x120:rate=10:duration=2','-f','lavfi','-i','sine=frequency=440:duration=2','-c:v','mpeg4','-c:a','aac','-shortest','-y',file]);
    const recognize=await createDouyinRecognizer({configPath:config});
    const result=await understandDouyinFile({file,duration:2,brain:{describeVideo:async()=> '测试画面'},recognize});
    assert.equal(result.audio.status,'unreliable');
    assert.equal(result.audio.segments[0].text,'合成测试声音');
    assert.equal(result.audio.segments[0].reliable,false);
    assert.equal(calls.length,1); assert.equal(calls[0].url,'/v1/audio/transcriptions');
    assert.equal(calls[0].authorization,'Bearer test-key');
    assert.ok(calls[0].data.includes(Buffer.from('RIFF'))); assert.ok(calls[0].data.includes(Buffer.from('test-model')));
  } finally { await new Promise(resolve=>server.close(resolve)); rmSync(dir,{recursive:true,force:true}); }
});

test('uses active matching gateway source when legacy STT host is obsolete', async()=>{
  const dir=mkdtempSync(join(process.env.TMPDIR || tmpdir(),'dy-asr-gateway-')); const calls=[];
  const server=http.createServer((req,res)=>{calls.push(req.url); req.resume(); res.writeHead(200,{'content-type':'application/json'}); res.end('{"text":"成功"}');});
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const config=join(dir,'config.json'); const base=`http://127.0.0.1:${server.address().port}/v1`;
    writeFileSync(config,JSON.stringify({douyin:{allowAudioTranscription:true},provider:[{type:'openai_whisper_api',enable:true,api_base:'http://invalid.invalid/v1',api_key:'test-key',model:'test-model'}],provider_sources:[{id:'google_gemini_openai',enable:true,api_base:base,api_key:'test-key'}]}));
    const recognize=await createDouyinRecognizer({configPath:config});
    assert.equal(await recognize(Buffer.from('audio')),'成功'); assert.deepEqual(calls,['/v1/audio/transcriptions']);
  } finally {await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
});

test('production watch supplies recognizer to full page perception',()=>{
  const source=readFileSync(new URL('../src/douyin-living.js',import.meta.url),'utf8');
  assert.match(source,/perceiveDouyinFullPage\(page,\s*activeBrain,\s*\{\s*recognize:\s*await createDouyinRecognizer\(\),\s*expectedWorkUrl:\s*resolvedWorkUrl,\s*restartFromBeginning:\s*true,\s*collectHostObservation:\s*!!interestMemory\s*&&\s*!safeTest\s*\}\)/);
});

test('missing or disabled recognizer configuration fails closed',async()=>{
  const dir=mkdtempSync(join(process.env.TMPDIR || tmpdir(),'dy-asr-config-'));
  try {
    assert.equal(await createDouyinRecognizer({configPath:join(dir,'missing')}),undefined);
    const config=join(dir,'config.json'); writeFileSync(config,JSON.stringify({provider:[{type:'openai_whisper_api',enable:false,api_base:'http://127.0.0.1/v1',api_key:'test',model:'test'}]}));
    assert.equal(await createDouyinRecognizer({configPath:config}),undefined);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
