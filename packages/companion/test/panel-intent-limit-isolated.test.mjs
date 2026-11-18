import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

test('all pending queue items, approval requests and persisted intents remain visible', async t => {
  const root = path.resolve(import.meta.dirname, '..');
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'panel-intent-limit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'scripts')); fs.mkdirSync(path.join(dir, 'data'));
  fs.copyFileSync(path.join(root, 'scripts/panel.mjs'), path.join(dir, 'scripts/panel.mjs'));
  fs.cpSync(path.join(root, 'src'), path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(dir, 'data/outbox.json'), JSON.stringify({ pending: Array.from({length: 7}, (_, i) => ({ text: `queue-${i}`, gid:'fixture' })) }));
  fs.writeFileSync(path.join(dir, 'data/dev-requests.jsonl'), [0,1,2].map(i => JSON.stringify({id:`r${i}`, status:'pending', title:`request-${i}`})).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'data/intents.json'), JSON.stringify({intents:[{text:'persisted'}, {text:'finished', doneAt:1}]}));
  const { handlePanelRequest } = await import(pathToFileURL(path.join(dir, 'scripts/panel.mjs')).href);
  const server = http.createServer((req, res) => handlePanelRequest(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/panel/api/snapshot`);
  const { intents } = await response.json();
  assert.equal(intents.length, 11);
  assert.deepEqual(intents.filter(x => x.badge === '心愿待审批').map(x => x.text), ['request-0（）','request-1（）','request-2（）']);
  assert.ok(intents.some(x => x.text === 'persisted'));
  assert.ok(!intents.some(x => x.text === 'finished'));
});
