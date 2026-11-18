import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

test('same desire title in different environments keeps both targets', async t => {
  const root = path.resolve(import.meta.dirname, '..');
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'panel-desire-env-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.mkdirSync(path.join(dir, 'data'));
  fs.copyFileSync(path.join(root, 'scripts/panel.mjs'), path.join(dir, 'scripts/panel.mjs'));
  fs.cpSync(path.join(root, 'src'), path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(dir, 'data/goals-desires.json'), JSON.stringify({activeDesires: {
    idle: {title:'想聊聊', strategy:'放空策略'}, group: {title:'想聊聊', strategy:'群聊策略'}
  }}));
  const {handlePanelRequest} = await import(pathToFileURL(path.join(dir, 'scripts/panel.mjs')).href);
  const server = http.createServer((req, res) => handlePanelRequest(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const data = await (await fetch(`http://127.0.0.1:${server.address().port}/panel/api/snapshot`)).json();
  assert.deepEqual(data.intents.map(({text, target}) => ({text, target})), [
    {text:'想聊聊', target:'摸鱼放空 · 策略：放空策略'},
    {text:'想聊聊', target:'QQ 群聊 · 策略：群聊策略'},
  ]);
});
