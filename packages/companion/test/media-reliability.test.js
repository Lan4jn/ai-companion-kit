import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIRecognizer } from '../src/video-audio-transcribe.js';
import { Brain } from '../src/brain.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('HTTP speech recognizer retries a transient timeout and succeeds', async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { if (++calls === 1) throw Object.assign(new Error('secret'), {name:'TimeoutError'}); return new Response(JSON.stringify({text:'测试'}), {status:200}); };
  try { const recognize = createOpenAIRecognizer({endpoint:'http://127.0.0.1:1/asr',apiKey:'secret',model:'test',timeoutMs:100}); assert.equal(await recognize(Buffer.from('synthetic')), '测试'); assert.equal(calls,2); }
  finally {globalThis.fetch=original;}
});

test('video empty reasoning result reports safe exhaustion metadata', async () => {
  const dir=mkdtempSync(join(process.env.TMPDIR || tmpdir(),'video-reliability-')); const file=join(dir,'test.mp4');
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=red:s=64x64:d=1','-c:v','libx264',file]);
  const original=globalThis.fetch, warn=console.warn, logs=[];
  console.warn=(...a)=>logs.push(a.join(' '));
  globalThis.fetch=async()=>new Response(JSON.stringify({choices:[{finish_reason:'length',message:{content:'',reasoning_content:'private-reasoning'}}],usage:{completion_tokens:4000,completion_tokens_details:{reasoning_tokens:3999}}}),{status:200});
  try {
    const brain=new Brain({apiKey:'secret',role:{},memory:{},visionFallback:{apiKey:'secret',baseUrl:'https://example.invalid',model:'test'}});
    assert.equal(await brain.describeVideo(file),null);
    assert.match(logs.join(' '),/finish=length/); assert.match(logs.join(' '),/reasoning_tokens=3999/);
    assert.doesNotMatch(logs.join(' '),/private-reasoning|secret/);
  } finally {globalThis.fetch=original;console.warn=warn;rmSync(dir,{recursive:true,force:true});}
});

test('video retries one transient HTTP failure without inventing results', async () => {
  const dir=mkdtempSync(join(process.env.TMPDIR || tmpdir(),'video-retry-')); const file=join(dir,'test.mp4');
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=red:s=64x64:d=1','-c:v','libx264',file]);
  const original=globalThis.fetch; let calls=0;
  globalThis.fetch=async()=> ++calls===1 ? new Response('',{status:503}) : new Response(JSON.stringify({choices:[{message:{content:'红色'}}]}),{status:200});
  try {const brain=new Brain({apiKey:'secret',role:{},memory:{},visionFallback:{apiKey:'secret',baseUrl:'https://example.invalid',model:'test'}}); assert.equal(await brain.describeVideo(file),'红色');assert.equal(calls,2);}
  finally {globalThis.fetch=original;rmSync(dir,{recursive:true,force:true});}
});
