import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {pathToFileURL} from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
test('private desire and motive fields stay out of the panel snapshot', async t => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'panel-private-desire-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  fs.mkdirSync(path.join(dir, 'scripts')); fs.mkdirSync(path.join(dir, 'data'));
  fs.copyFileSync(path.join(root, 'scripts/panel.mjs'), path.join(dir, 'scripts/panel.mjs'));
  fs.cpSync(path.join(root, 'src'), path.join(dir, 'src'), {recursive:true});
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  const data = path.join(dir, 'data');
  fs.writeFileSync(path.join(data, 'goals-desires.json'), JSON.stringify({lifeGoals:[{title:'public-life'}], activeDesires:{
    dm_owner:{title:'SECRET_DESIRE',strategy:'SECRET_STRATEGY'}, group:{title:'public-group',strategy:'public-strategy'}
  }}));
  const {handlePanelRequest} = await import(pathToFileURL(path.join(dir, 'scripts/panel.mjs')).href);
  const server = http.createServer((req,res) => handlePanelRequest(req,res));
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => server.close());
  const snapshot = async () => (await fetch(`http://127.0.0.1:${server.address().port}/panel/api/snapshot`)).json();
  let body = await snapshot();
  assert.doesNotMatch(JSON.stringify(body), /SECRET_DESIRE|SECRET_STRATEGY/);
  assert.match(JSON.stringify(body), /public-group/);
  assert.match(JSON.stringify(body), /public-strategy/);
  assert.match(JSON.stringify(body), /public-life/);
  fs.unlinkSync(path.join(data, 'goals-desires.json'));
  fs.writeFileSync(path.join(data, 'motive.json'), JSON.stringify({goals:[
    {goal:'SECRET_GOAL', how:'SECRET_HOW', done:'SECRET_DONE',targetKey:'private:synthetic-id',targetName:'SECRET_NAME'},
    {goal:'public-goal',how:'public-how',targetKey:'group:synthetic-id'}
  ]}));
  body = await snapshot();
  assert.doesNotMatch(JSON.stringify(body), /SECRET_GOAL|SECRET_HOW|SECRET_DONE|SECRET_NAME|private:synthetic-id/);
  assert.match(JSON.stringify(body), /public-goal/);
});
