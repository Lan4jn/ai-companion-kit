import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {pathToFileURL} from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
async function fixture(t, config) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'panel-owner-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  fs.mkdirSync(path.join(dir, 'scripts')); fs.mkdirSync(path.join(dir, 'data'));
  fs.cpSync(path.join(root, 'scripts/panel.mjs'), path.join(dir, 'scripts/panel.mjs'));
  fs.cpSync(path.join(root, 'src'), path.join(dir, 'src'), {recursive:true});
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  const before = new Map(['uncaughtException','unhandledRejection','SIGTERM'].map(e => [e,new Set(process.listeners(e))]));
  const {handlePanelRequest} = await import(pathToFileURL(path.join(dir, 'scripts/panel.mjs')).href);
  for (const [event, listeners] of before) for (const listener of process.listeners(event)) if (!listeners.has(listener)) process.removeListener(event, listener);
  const calls = [];
  let history = [], seenKey = '', forcedReply;
  const brain = {memory:{sessionTurns(key) {seenKey=key; return history;}}, reply: async input => { calls.push(input); await new Promise(r => setTimeout(r, input.text === 'first' ? 20 : 1)); return {text: forcedReply ?? 'reply '+input.text}; }};
  const server = http.createServer((req,res) => handlePanelRequest(req,res,{brain}));
  await new Promise(r => server.listen(0,'127.0.0.1',r)); t.after(() => server.close());
  return {dir,calls,origin:`http://127.0.0.1:${server.address().port}`,setHistory:value=>{history=value;},historyKey:()=>seenKey,setReply:value=>{forcedReply=value;}};
}

test('panel blocks canned reply before persistence and preserves quotes', async t => {
  const f = await fixture(t,{ownerIds:['11111']});
  f.setReply('这条我认。');
  let res = await fetch(f.origin+'/panel/api/chat/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'fixture'})});
  assert.equal(res.status,502);
  assert.equal((await res.json()).unknown,true);
  assert.equal(fs.existsSync(path.join(f.dir,'data/turns.jsonl')),false);
  f.setReply('她说“这条我认”，是什么意思？');
  res = await fetch(f.origin+'/panel/api/chat/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'fixture'})});
  assert.equal(res.status,200);
  assert.equal((await res.json()).reply,'她说“这条我认”，是什么意思？');
});

test('fallback chat shows only exact panel session', async t => {
  const f = await fixture(t,{ownerIds:['11111'],bili:{ownerMid:'22222'}});
  const turns = [
    {where:'private:11111',who:'owner',text:'qq fixture'},
    {where:'private:bili:22222',who:'self',text:'bili fixture'},
    {where:'group:11111',who:'owner',text:'group secret'},
    {where:'private:111119',who:'owner',text:'other secret'},
    {where:'private:bili:222229',who:'owner',text:'other bili secret'},
    {where:'panel:11111',who:'面板用户',text:'panel fixture',reply:'panel reply'},
    {where:'panel:111119',who:'other',text:'other panel secret'},
    {who:'unknown',text:'unowned secret'},
  ];
  fs.writeFileSync(path.join(f.dir,'data/turns.jsonl'),turns.map(x=>JSON.stringify(x)).join('\n'));
  const snapshot = await (await fetch(f.origin+'/panel/api/snapshot')).json();
  assert.deepEqual(snapshot.chat.rows.map(r=>r.text),['panel fixture','panel reply']);
});

test('legacy unowned chat-tail never appears in snapshot', async t => {
  const f = await fixture(t,{ownerIds:['11111']});
  fs.writeFileSync(path.join(f.dir,'data/chat-tail.jsonl'), JSON.stringify({dir:'in',text:'legacy secret'})+'\n');
  const snapshot = await (await fetch(f.origin+'/panel/api/snapshot')).json();
  assert.deepEqual(snapshot.chat.rows,[]);
});

test('panel transcript rejects unowned and different session rows', async t => {
  const f = await fixture(t,{ownerIds:['11111']});
  const rows = [
    {dir:'in',text:'unowned'}, {where:'private:11111',dir:'out',text:'private'},
    {where:'panel:111119',dir:'in',text:'other'}, {where:'panel:11111',dir:'in',text:'visible'}
  ];
  fs.writeFileSync(path.join(f.dir,'data/panel-chat-tail.jsonl'),rows.map(JSON.stringify).join('\n'));
  const snapshot = await (await fetch(f.origin+'/panel/api/snapshot')).json();
  assert.deepEqual(snapshot.chat.rows.map(r=>r.text),['visible']);
});

test('sent panel conversation remains visible while unrelated private records stay hidden', async t => {
  const f = await fixture(t,{ownerIds:['11111']});
  const turns = [
    {where:'private:11111',text:'QQ_PRIVATE_FIXTURE',reply:'QQ_REPLY_FIXTURE'},
    {where:'private:bili:22222',text:'BILI_PRIVATE_FIXTURE'},
    {where:'panel:22222',text:'OTHER_PANEL_FIXTURE'},
  ];
  fs.writeFileSync(path.join(f.dir,'data/turns.jsonl'),turns.map(JSON.stringify).join('\n')+'\n');
  fs.writeFileSync(path.join(f.dir,'data/chat-tail.jsonl'),JSON.stringify({dir:'in',text:'LEGACY_PRIVATE_FIXTURE'})+'\n');
  const response = await fetch(f.origin+'/panel/api/chat/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'panel message'})});
  assert.equal(response.status,200);
  const snapshot = await (await fetch(f.origin+'/panel/api/snapshot')).json();
  assert.deepEqual(snapshot.chat.rows.map(r=>r.text),['panel message','reply panel message']);
  assert.doesNotMatch(JSON.stringify(snapshot),/QQ_PRIVATE_FIXTURE|QQ_REPLY_FIXTURE|BILI_PRIVATE_FIXTURE|OTHER_PANEL_FIXTURE|LEGACY_PRIVATE_FIXTURE/);
});

test('each configured owner is consistently used for concurrent chat persistence', async t => {
  const a = await fixture(t,{ownerIds:['11111']});
  const b = await fixture(t,{ownerIds:['22222']});
  await Promise.all([a,b].flatMap(f => ['first','second'].map(text => fetch(f.origin+'/panel/api/chat/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text})}).then(r => assert.equal(r.status,200)))));
  for (const [f,id] of [[a,'11111'],[b,'22222']]) {
    const records = fs.readFileSync(path.join(f.dir,'data/turns.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(records.length,2);
    for (const record of records) {
      const call = f.calls.find(c => c.text === record.text);
      assert.equal(record.where, 'panel:'+id);
      assert.equal(record.where,call.key);
      assert.equal(record.who,call.userName);
      assert.equal(call.userId,id);
    }
  }
});

test('panel forwards exact session history to brain', async t => {
  const f = await fixture(t,{ownerIds:['11111']});
  f.setHistory([{role:'user',content:'fixture earlier'}]);
  const res = await fetch(f.origin+'/panel/api/chat/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'next'})});
  assert.equal(res.status,200);
  assert.deepEqual(f.calls[0].history,[{role:'user',content:'fixture earlier'}]);
  assert.equal(f.historyKey(),'panel:11111');
});

test('missing or malformed ownerIds cannot invoke brain or persist a turn', async t => {
  for (const config of [{},{ownerQQ:'33333'},{ownerIds:['']},{ownerIds:['12:group']},{ownerIds:[{}]}]) {
    const f = await fixture(t,config);
    const res = await fetch(f.origin+'/panel/api/chat/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'fixture'})});
    assert.equal(res.status,503);
    assert.equal(f.calls.length,0);
    assert.equal(fs.existsSync(path.join(f.dir,'data/turns.jsonl')),false);
    assert.equal(fs.existsSync(path.join(f.dir,'data/chat-tail.jsonl')),false);
  }
});
