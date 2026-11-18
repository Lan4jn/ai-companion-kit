import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { executePhoneTool } from '../src/phone-tools.js';

test('voice tool sends validated context to Fish first without argv leaks', async () => {
  const cwd = process.cwd(), oldPath = process.env.PATH;
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'fish-chain-'));
  fs.writeFileSync(path.join(dir,'config.json'), JSON.stringify({tts:{provider:'doubao',apiKey:'doubao-test',fish:{apiKey:'fish-secret',referenceId:'ref-test'}}}));
  fs.writeFileSync(path.join(dir,'curl'), `#!/usr/bin/env node\nconst fs=require('fs');let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{fs.writeFileSync(${JSON.stringify(path.join(dir,'request'))},s);fs.writeFileSync(${JSON.stringify(path.join(dir,'argv'))},JSON.stringify(process.argv));process.stdout.write(Buffer.concat([Buffer.from('ID3'),Buffer.alloc(600)]));});\n`,{mode:0o700});
  process.chdir(dir); process.env.PATH = `${dir}:${oldPath}`;
  try {
    let r = await executePhoneTool('voice_say', {text:'<think>secret thought</think>你好[very angry]', emotion:'任意私密语境', voice_emotion:'sad', intensity:'stronger'}, {voiceMood:'甜美开心、带轻快笑意'});
    assert.equal(r.status,'success'); assert.match(r.voice,/^fish:/);
    let request=fs.readFileSync(path.join(dir,'request'),'utf8');
    assert.match(request,/\[extremely sad\]/); assert.doesNotMatch(request,/secret thought|私密语境|\[very angry\]/);
    assert.doesNotMatch(fs.readFileSync(path.join(dir,'argv'),'utf8'),/fish-secret|你好/);
    r = await executePhoneTool('voice_say', {text:'你好', emotion:'', intensity:'mild'}, {voiceMood:'假装生气的小娇哼、微恼'});
    assert.equal(r.status,'success'); assert.match(fs.readFileSync(path.join(dir,'request'),'utf8'),/\[slightly angry\]/);
    for (const [voice_emotion, intensity, tags] of [
      ['cry', 'medium', '[sad][sobbing]'],
      ['cry', 'strong', '[very sad][sobbing]'],
      ['angry', 'medium', '[angry]'],
      ['shout', 'stronger', '[extremely angry][shouting]'],
    ]) {
      r = await executePhoneTool('voice_say', {text:'你好', voice_emotion, intensity}, {voiceMood:'甜美开心、带轻快笑意'});
      assert.equal(r.status, 'success');
      assert.ok(fs.readFileSync(path.join(dir,'request'),'utf8').includes(tags), `${voice_emotion}/${intensity}`);
    }
  } finally { process.chdir(cwd); process.env.PATH=oldPath; fs.rmSync(dir,{recursive:true,force:true}); }
});
