import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { executePhoneTool } from '../src/phone-tools.js';

test('voice tool passes session mood when model omits emotion, without speaking internal thought', async () => {
  const cwd = process.cwd();
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'voice-context-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({tts:{provider:'doubao',apiKey:'fake',resourceId:'seed-icl-2.0',voices:{cute:'S_test'}}}));
  process.chdir(dir);
  const original = https.request;
  let payload;
  https.request = (_url, _opts, callback) => {
    const req = new EventEmitter();
    req.write = data => { payload = JSON.parse(data); };
    req.end = () => { const res = new EventEmitter(); res.statusCode = 200; callback(res); process.nextTick(() => {res.emit('data', Buffer.from(JSON.stringify({data:Buffer.from('audio').toString('base64')})+'\n')); res.emit('end');}); };
    return req;
  };
  try {
    const result = await executePhoneTool('voice_say', {text:'<think>私密思考</think>我陪着你。'}, {voiceMood:'有点担忧，轻声安慰'});
    assert.equal(result.status, 'success');
    assert.equal(payload.req_params.text, '我陪着你。');
    assert.match(JSON.parse(payload.req_params.additions).context_texts[0], /担忧/);
    assert.equal(payload.req_params.speaker, 'S_test');
    await executePhoneTool('voice_say', {text:'太好了！', emotion:'轻快高兴，但不夸张'}, {voiceMood:'有点担忧'});
    assert.match(JSON.parse(payload.req_params.additions).context_texts[0], /轻快高兴/);
    assert.doesNotMatch(JSON.parse(payload.req_params.additions).context_texts[0], /担忧/);
    await executePhoneTool('voice_say', {text:'请听（星期五）的安排。', emotion:'<think>不应发送的思考</think>温柔'}, {});
    assert.equal(payload.req_params.text, '请听（星期五）的安排。');
    assert.doesNotMatch(JSON.parse(payload.req_params.additions).context_texts[0], /不应发送的思考|think/);
  } finally { https.request = original; process.chdir(cwd); fs.rmSync(dir,{recursive:true,force:true}); }
});
