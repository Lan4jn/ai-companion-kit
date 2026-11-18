import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

test('completed playback observation is not presented as an ongoing activity', async t => {
  const root = path.resolve(import.meta.dirname, '..');
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'panel-focus-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  fs.mkdirSync(path.join(dir, 'scripts')); fs.mkdirSync(path.join(dir, 'data'));
  fs.copyFileSync(path.join(root, 'scripts/panel.mjs'), path.join(dir, 'scripts/panel.mjs'));
  fs.cpSync(path.join(root, 'src'), path.join(dir, 'src'), {recursive:true});
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(dir, 'data/current-activity.json'), JSON.stringify({type:'bili',title:'合成视频',up:'合成作者',watched:90,duration:90,at:Date.now()}));
  const {handlePanelRequest} = await import(pathToFileURL(path.join(dir, 'scripts/panel.mjs')).href);
  const server = http.createServer((req,res) => handlePanelRequest(req,res));
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const focus = (await (await fetch(base+'/panel/api/snapshot')).json()).focus;
  assert.match(focus.current, /最近/);
  assert.doesNotMatch(focus.errand.what, /观看中/);
  assert.equal(focus.errand.observation, true);
  const html = await (await fetch(base+'/panel/')).text();
  assert.match(html, /f\.errand\.observation\s*\?/);
});
