import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { synthesize } from '../src/tts.js';

test('long synthetic speech reaches the provider without truncation', async () => {
  const cwd = process.cwd(), oldPath = process.env.PATH;
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'tts-long-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({tts:{fish:{apiKey:'synthetic',referenceId:'synthetic'}}}));
  fs.writeFileSync(path.join(dir, 'curl'), `#!/usr/bin/env node\nconst fs=require('fs');let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{fs.writeFileSync(${JSON.stringify(path.join(dir,'request'))},s);process.stdout.write(Buffer.concat([Buffer.from('ID3'),Buffer.alloc(600)]));});\n`, {mode:0o700});
  process.chdir(dir); process.env.PATH = `${dir}:${oldPath}`;
  try {
    const text = '这是需要完整朗读的测试内容。'.repeat(30) + '最后的关键信息';
    const result = await synthesize(text);
    assert.equal(result.ok, true);
    assert.ok(fs.readFileSync(path.join(dir, 'request'), 'utf8').includes(text));
  } finally { process.chdir(cwd); process.env.PATH = oldPath; fs.rmSync(dir,{recursive:true,force:true}); }
});
