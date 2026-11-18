import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

test('desire fallback keeps distinct titles sharing a prefix and fills the sixth slot', async t => {
  const root = path.resolve(import.meta.dirname, '..');
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'panel-desires-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'scripts')); fs.mkdirSync(path.join(dir, 'data'));
  fs.copyFileSync(path.join(root, 'scripts/panel.mjs'), path.join(dir, 'scripts/panel.mjs'));
  fs.cpSync(path.join(root, 'src'), path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(dir, 'data/goals-desires.json'), JSON.stringify({ activeDesires: {
    idle: {title:'共同前缀abcdefgh第一项'}, group: {title:'共同前缀abcdefgh第二项'}
  }}));
  const { handlePanelRequest } = await import(pathToFileURL(path.join(dir, 'scripts/panel.mjs')).href);
  const server = http.createServer((req, res) => handlePanelRequest(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const snapshot = async () => (await fetch(`http://127.0.0.1:${server.address().port}/panel/api/snapshot`)).json();
  fs.writeFileSync(path.join(dir, 'data/intents.json'), JSON.stringify({intents: Array.from({length: 5}, (_, i) => ({text:`已有意图${i}`}))}));
  assert.equal((await snapshot()).intents.length, 6);
  fs.unlinkSync(path.join(dir, 'data/intents.json'));
  assert.deepEqual((await snapshot()).intents.map(x => x.text), ['共同前缀abcdefgh第一项', '共同前缀abcdefgh第二项']);
});
