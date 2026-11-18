import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {pathToFileURL} from 'node:url';

async function setup(t, files = {}) {
  const root = path.resolve(import.meta.dirname, '..');
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'panel-validation-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  fs.mkdirSync(path.join(dir,'scripts')); fs.mkdirSync(path.join(dir,'data'));
  fs.copyFileSync(path.join(root,'scripts/panel.mjs'),path.join(dir,'scripts/panel.mjs'));
  fs.cpSync(path.join(root,'src'),path.join(dir,'src'),{recursive:true});
  fs.writeFileSync(path.join(dir,'package.json'),'{"type":"module"}');
  for (const [name, value] of Object.entries(files)) fs.writeFileSync(path.join(dir,'data',name),value);
  const events = ['uncaughtException','unhandledRejection','SIGTERM'];
  const before = Object.fromEntries(events.map(e => [e,new Set(process.listeners(e))]));
  const {handlePanelRequest} = await import(pathToFileURL(path.join(dir,'scripts/panel.mjs')).href);
  for (const e of events) for (const l of process.listeners(e)) if (!before[e].has(l)) process.removeListener(e,l);
  const server = http.createServer((req,res) => handlePanelRequest(req,res));
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => server.close());
  const post = async p => {const r = await fetch(`http://127.0.0.1:${server.address().port}/panel${p}`,{method:'POST'}); return r.json();};
  return {dir,post};
}

test('tarot switch refuses corrupted state and invalid parameter', async t => {
  const broken = '{broken';
  const {dir,post} = await setup(t, {'tarot.json':broken});
  assert.equal((await post('/api/tarot?enabled=1')).ok,false);
  assert.equal(fs.readFileSync(path.join(dir,'data/tarot.json'),'utf8'),broken);
  fs.writeFileSync(path.join(dir,'data/tarot.json'),'{"enabled":true}');
  assert.equal((await post('/api/tarot')).ok,false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'data/tarot.json'))).enabled,true);
});

test('invalid or absent numeric values never modify state', async t => {
  const mood = '{"byKey":{}}', virtue = '{"axes":{"诚实":4}}';
  const {dir,post} = await setup(t, {'mood.json':mood,'virtue.json':virtue});
  for (const value of ['', '&value=', '&value=%20', '&value=2.5']) {
    assert.equal((await post('/api/set?kind=mood'+value)).ok,false);
    assert.equal((await post('/api/set?kind=virtue&axis='+encodeURIComponent('诚实')+value)).ok,false);
  }
  assert.equal(fs.readFileSync(path.join(dir,'data/mood.json'),'utf8'),mood);
  assert.equal(fs.readFileSync(path.join(dir,'data/virtue.json'),'utf8'),virtue);
});
