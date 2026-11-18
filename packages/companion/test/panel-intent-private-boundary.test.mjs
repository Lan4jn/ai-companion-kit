import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {pathToFileURL} from 'node:url';

test('private-target persisted intents do not leak private text in snapshot', async t => {
  const root = path.resolve(import.meta.dirname, '..');
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'panel-intent-privacy-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  fs.mkdirSync(path.join(dir,'scripts')); fs.mkdirSync(path.join(dir,'data'));
  fs.copyFileSync(path.join(root,'scripts/panel.mjs'),path.join(dir,'scripts/panel.mjs'));
  fs.cpSync(path.join(root,'src'),path.join(dir,'src'),{recursive:true});
  fs.writeFileSync(path.join(dir,'package.json'),'{"type":"module"}');
  fs.writeFileSync(path.join(dir,'data/intents.json'),JSON.stringify({intents:[
    {targetKey:'private:12345',text:'synthetic private message password synthetic-secret'},
    {targetKey:'group:12345',text:'synthetic public intention'}
  ]}));
  const {handlePanelRequest}=await import(pathToFileURL(path.join(dir,'scripts/panel.mjs')).href);
  const server=http.createServer((req,res)=>handlePanelRequest(req,res));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>server.close());
  const snapshot=await (await fetch(`http://127.0.0.1:${server.address().port}/panel/api/snapshot`)).json();
  assert.doesNotMatch(JSON.stringify(snapshot.intents),/synthetic-secret|synthetic private message|private:12345/);
  assert.equal(snapshot.intents.length,2);
  assert.ok(snapshot.intents.some(x=>x.text==='synthetic public intention'));
});
