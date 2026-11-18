import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
import { Memory } from '../src/memory.js';
import { handleTurn } from '../src/index.js';
import { initializeManagedStore, createManagedMemoryBrain } from '../src/memory-brain-trust.js';
import { OneBot } from '../src/transport-onebot.js';
register('./memory-brain-fake-ws-loader.js', import.meta.url);

test('trusted replies are recalled before forget, not after an ancestor is forgotten', async t => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'turn-reply-provenance-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const scope = {tenant:'companion', platform:'qq', type:'private', session:'private:1', user:'1'};
  const directory = path.join(dir, 'memory-brain-scoped');
  initializeManagedStore(directory);
  const store = createManagedMemoryBrain({backend:'sqlite-fts', directory, scope, sources:['qq-private-message'], trustedProcess:true});
  const memory = new Memory({dir});
  const prompts = [];
  const brain = {reply: async p => {
    prompts.push(p);
    memory.logTurn({where:p.key, who:p.userName, text:p.text, reply:`answer-${prompts.length}`, identity:p.historyIdentity});
    return {text:''};
  }};
  let resolve;
  const bot = new OneBot({wsUrl:'ws://fixture', onMessage:m => resolve(m)});
  bot.api = async () => ({ok:false});
  bot.getMyGroupCard = async () => '';
  while (!bot.ws) await new Promise(r => setTimeout(r, 1));
  bot.ws.emit('open');
  t.after(() => bot.close());
  const send = async (id, text) => {
    const received = new Promise(r => {resolve = r;});
    bot.ws.emit('message', JSON.stringify({post_type:'message', message_type:'private', user_id:1, message_id:id, message:[{type:'text', data:{text}}]}));
    await handleTurn({brain, memory, bot:{}, human:{}, waker:{}}, [await received], {ownerIds:['1'], dataDir:dir, memoryBrain:{enabled:true, backend:'sqlite-fts', trustedProcess:true, trustedScope:scope, authorizedSources:['qq-private-message']}});
  };
  await send(11, 'first');
  await send(12, 'second');
  assert.equal(prompts[1].history[0].reply, 'answer-1');
  await send(13, 'third');
  assert.deepEqual(prompts[2].history.map(r => r.reply), ['answer-1', 'answer-2']);
  await store.forget(scope, {source:'qq-private-message', evidence:'onebot-message:11'});
  await send(14, 'fourth');
  assert.deepEqual(prompts[3].history.map(r => [r.identity.evidence, r.reply]), [[['onebot-message:12'], ''], [['onebot-message:13'], '']]);
});

test('unproven replies and records from other users stay hidden', async t => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'turn-unproven-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const memory = new Memory({dir});
  memory.logTurn({where:'private:1', who:'one', text:'hello', reply:'unknown source', identity:{platform:'qq', user:'1', evidence:['onebot-message:1'], text:'hello'}});
  memory.logTurn({where:'private:2', who:'two', text:'secret', reply:'secret reply', identity:{platform:'qq', user:'2', evidence:['onebot-message:2'], text:'secret'}});
  const result = await memory.sessionTurnsFiltered('private:1', 80, async evidence => evidence);
  assert.equal(result.length, 1);
  assert.equal(result[0].reply, '');
  assert.equal(result[0].text, 'hello');
});

test('caller-supplied dependency claims cannot authenticate a reply', async t => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'turn-forged-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const memory = new Memory({dir});
  memory.logTurn({where:'private:1', who:'one', text:'hello', reply:'forged', identity:{platform:'qq', user:'1', evidence:['onebot-message:1'], text:'hello', replyEvidence:['onebot-message:1'], replyProvenance:{complete:true, evidence:['onebot-message:1']}}});
  const rows = await memory.sessionTurnsFiltered('private:1', 80, async evidence => evidence);
  assert.equal(rows[0].reply, '');
});
