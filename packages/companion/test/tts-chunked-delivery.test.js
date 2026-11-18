import test from 'node:test';
import assert from 'node:assert/strict';
import { splitSpeechText, synthesizeChunks } from '../src/tts.js';
import fs from 'node:fs';
import path from 'node:path';

test('long text splits losslessly on Unicode boundaries with bounded UTF-8 bytes', () => {
  const text = '你好，世界！😀abc '.repeat(90) + '结尾';
  const parts = splitSpeechText(text, 120);
  assert.ok(parts.length > 1);
  assert.equal(parts.join(''), text);
  assert.ok(parts.every(p => Buffer.byteLength(p) <= 120 && !/[\uD800-\uDBFF]$/.test(p)));
});

test('chunks synthesize sequentially and fail closed on partial failure', async () => {
  const text = '第一句内容。'.repeat(80);
  const seen = [];
  const result = await synthesizeChunks(text, { maxChunkBytes: 80 }, async (part, opts) => {
    seen.push([part, opts.emotion]);
    return {ok:true, base64:Buffer.from(part).toString('base64'), spokenText:part, bytes:1, voice:'mock'};
  });
  assert.equal(result.ok, true);
  assert.equal(result.chunks.map(c => c.spokenText).join(''), text);
  assert.equal(seen.length, result.chunks.length);
  let calls = 0;
  const failed = await synthesizeChunks(text, { maxChunkBytes: 80 }, async part => {
    calls++;
    return calls === 2 ? {ok:false, error:'mock'} : {ok:true, base64:'YQ==', spokenText:part, voice:'mock'};
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.chunks, undefined);
  assert.equal(calls, 2);
});


test('voice tool sends bounded ordered Fish requests with emotion', async () => {
  const {executePhoneTool} = await import('../src/phone-tools.js');
  const cwd=process.cwd(), oldPath=process.env.PATH;
  const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'tts-chunks-'));
  fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({tts:{fish:{apiKey:'fake',referenceId:'fake'}}}));
  const requests=path.join(dir,'requests');
  fs.writeFileSync(path.join(dir,'curl'), `#!/usr/bin/env node\nconst fs=require('fs');let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{fs.appendFileSync(${JSON.stringify(requests)},JSON.stringify(s)+'\\n');process.stdout.write(Buffer.concat([Buffer.from('ID3'),Buffer.alloc(600)]))});\n`,{mode:0o700});
  process.chdir(dir);process.env.PATH=dir+':'+oldPath;
  try {
    const text='这是一段需要朗读的话。'.repeat(90);
    const result=await executePhoneTool('voice_say',{text,voice_emotion:'happy'},{});
    assert.equal(result.status,'success');assert.ok(result.voice_chunks.length>1);
    assert.equal(result.voice_chunks.map(c=>c.spokenText).join(''),text);
    const lines=fs.readFileSync(requests,'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(lines.length,result.voice_chunks.length);
    for(let i=0;i<lines.length;i++){assert.ok(lines[i].includes('[slightly happy]'));assert.ok(lines[i].includes(result.voice_chunks[i].spokenText));}
  } finally {process.chdir(cwd);process.env.PATH=oldPath;fs.rmSync(dir,{recursive:true,force:true})}
});
