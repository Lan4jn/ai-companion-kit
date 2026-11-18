import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Memory} from '../src/memory.js';

test('dependency validation fails closed and checks every ancestor', async t => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'deps-validation-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const memory = new Memory({dir});
  const identity = {platform:'qq', user:'1', evidence:['onebot-message:1'], text:'hello'};
  const base = {where:'private:1', who:'one', text:'hello', reply:'answer', identity};
  const deps = ['onebot-message:1', 'onebot-message:2'];
  memory.withTrustedTurn({identity, deps}, () => memory.logTurn(base));
  let rows = await memory.sessionTurnsFiltered('private:1', 80, async e => e);
  assert.equal(rows[0].reply, 'answer');
  rows = await memory.sessionTurnsFiltered('private:1', 80, async e => e.filter(x => x !== 'onebot-message:2'));
  assert.equal(rows[0].reply, '');
  rows = await memory.sessionTurnsFiltered('private:1', 80, async e => { if (e.includes('onebot-message:2')) throw Error('unavailable'); return e; });
  assert.equal(rows[0].reply, '');
  for (const bad of [[], ['onebot-message:1','onebot-message:1'], [1], ['invalid'], Array.from({length:21}, (_, i) => `onebot-message:${i}`), 'onebot-message:1']) {
    memory.withTrustedTurn({identity, deps:bad}, () => memory.logTurn(base));
  }
  rows = await memory.sessionTurnsFiltered('private:1', 80, async e => e);
  assert.deepEqual(rows.slice(1).map(r => r.reply), Array(6).fill(''));
});

test('trusted context expires even for detached asynchronous callbacks', async t => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'deps-context-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const memory = new Memory({dir});
  const identity = {platform:'qq', user:'1', evidence:['onebot-message:1'], text:'hello'};
  let later;
  const gate = new Promise(resolve => { later = resolve; });
  let detached;
  await memory.withTrustedTurn({identity, deps:identity.evidence}, async () => {
    detached = gate.then(() => memory.logTurn({where:'private:1', text:'hello', reply:'late', identity}));
  });
  later(); await detached;
  assert.equal((await memory.sessionTurnsFiltered('private:1', 80, async e => e))[0].reply, '');
});
