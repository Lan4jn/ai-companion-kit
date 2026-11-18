import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { executePhoneTool } from '../src/phone-tools.js';

test('voice chain preserves recognizable emotion descriptions and explicit intensity safely', async () => {
  const cwd = process.cwd(), oldPath = process.env.PATH;
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'voice-intensity-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({tts:{fish:{apiKey:'test-key',referenceId:'test-voice'}}}));
  fs.writeFileSync(path.join(dir, 'curl'), `#!/usr/bin/env node\nconst fs=require('fs');let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{fs.writeFileSync(${JSON.stringify(path.join(dir,'request'))},s);process.stdout.write(Buffer.concat([Buffer.from('ID3'),Buffer.alloc(600)]));});\n`, {mode:0o700});
  process.chdir(dir); process.env.PATH = `${dir}:${oldPath}`;
  try {
    for (const [args, expected] of [
      [{text:'太好了',emotion:'轻快高兴，但不夸张'}, '[slightly happy]'],
      [{text:'太好了',emotion:'开心',voice_emotion:'happy',intensity:'stronger'}, '[excited][laughing]'],
      [{text:'我很难过',emotion:'伤心',voice_emotion:'sad',intensity:'strong'}, '[very sad]'],
      [{text:'普通说话',emotion:'自然平静',voice_emotion:'natural',intensity:'stronger'}, '普通说话'],
    ]) {
      assert.equal((await executePhoneTool('voice_say', args, {})).status, 'success');
      const body = fs.readFileSync(path.join(dir,'request'),'utf8');
      assert.ok(body.includes(expected), body);
      assert.doesNotMatch(body, /轻快高兴|不夸张|自然平静/);
    }
  } finally { process.chdir(cwd); process.env.PATH=oldPath; fs.rmSync(dir,{recursive:true,force:true}); }
});
