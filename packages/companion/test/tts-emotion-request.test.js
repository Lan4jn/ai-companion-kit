import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { synthesize } from '../src/tts.js';

test('configured speed and all emotional instructions reach the Doubao request', async () => {
  const oldCwd = process.cwd();
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tts-test-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({tts:{provider:'doubao',apiKey:'test',resourceId:'seed-icl-2.0',speedRatio:0.9,voices:{cute:'test-voice'}}}));
  process.chdir(dir);
  const original = https.request;
  let sent;
  https.request = (_url, _opts, callback) => {
    const req = new EventEmitter();
    req.write = data => { sent = JSON.parse(data); };
    req.end = () => { const res = new EventEmitter(); res.statusCode=200; callback(res); process.nextTick(() => { res.emit('data', Buffer.from(JSON.stringify({data:Buffer.from('fake-audio').toString('base64')})+'\n')); res.emit('end'); }); };
    return req;
  };
  try {
    const result = await synthesize('[轻笑]你好', {emotion:'温柔'});
    assert.equal(result.ok,true);
    assert.equal(sent.req_params.audio_params.speech_rate,-10);
    const contexts = JSON.parse(sent.req_params.additions).context_texts;
    assert.equal(contexts.length,1);
    assert.match(contexts[0],/温柔/);
    assert.match(contexts[0],/轻笑/);
    const markerOnly = await synthesize('[轻笑]', {emotion:'温柔'});
    assert.equal(markerOnly.ok, false, 'a bare direction must not be spoken');
  } finally { https.request=original; process.chdir(oldCwd); fs.rmSync(dir,{recursive:true,force:true}); }
});
