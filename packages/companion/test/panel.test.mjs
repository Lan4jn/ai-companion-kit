import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
async function fixture(t, files = {}, brain = null, live = false, owner = null) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'panel-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.cpSync(path.join(root, 'scripts/panel.mjs'), path.join(dir, 'scripts/panel.mjs'));
  fs.cpSync(path.join(root, 'src'), path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  if (owner) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ownerIds:[owner]}));
  fs.mkdirSync(path.join(dir, 'data'));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, 'data', name), content);
  const events = ['uncaughtException', 'unhandledRejection', 'SIGTERM'];
  const before = Object.fromEntries(events.map(event => [event, new Set(process.listeners(event))]));
  const { handlePanelRequest } = await import(pathToFileURL(path.join(dir, 'scripts/panel.mjs')).href);
  for (const event of events) for (const listener of process.listeners(event)) if (!before[event].has(listener)) process.removeListener(event, listener);
  const respectGuard = live ? (await import(pathToFileURL(path.join(dir, 'src/respect-guard.js')).href)).createRespectGuard({ file: path.join(dir, 'data/respect.json') }) : null;
  const server = http.createServer((req, res) => handlePanelRequest(req, res, { brain, respectGuard, getBridgeStatus: live ? () => ({ alive: false }) : null }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const request = async (url, method = 'GET', body = undefined) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/panel${url}`, { method, ...(body ? {headers:{'content-type':'application/json'},body:JSON.stringify(body)} : {}) });
    return { status: res.status, body: await res.json() };
  };
  return { request, dir, respectGuard };
}

test('virtue edit, reset and undo persist in isolated data', async t => {
  const original = { version: 2, axes: { '诚实': 4 }, dayBudget: {} };
  const { request, dir } = await fixture(t, { 'virtue.json': JSON.stringify(original) });
  assert.equal((await request('/api/set?kind=virtue&axis='+encodeURIComponent('诚实')+'&value=7', 'POST')).body.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'data/virtue.json'))).axes['诚实'], 7);
  assert.equal((await request('/api/reset?target=virtue', 'POST')).body.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'data/virtue.json'))).axes['诚实'], 0);
  assert.equal((await request('/api/undo?target=virtue', 'POST')).body.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'data/virtue.json'))).axes['诚实'], 7);
});

test('tarot toggle persists in isolated data', async t => {
  const { request, dir } = await fixture(t);
  assert.equal((await request('/api/tarot?enabled=0', 'POST')).body.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'data/tarot.json'))).enabled, false);
  assert.equal((await request('/api/tarot?enabled=1', 'POST')).body.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'data/tarot.json'))).enabled, true);
});

test('unblock does not report success when active guard cache cannot be updated', async t => {
  const users = { users: { '42': { name: 'example', strikes: 5, disliked: true } } };
  const { request, dir } = await fixture(t, { 'respect.json': JSON.stringify(users) });
  const result = await request('/api/respect/unblock?uid=42', 'POST');
  assert.equal(result.body.ok, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'data/respect.json'))).users['42'].disliked, true);
});

test('notebook rejects symlink escaping notebook root', async t => {
  const { request, dir } = await fixture(t);
  fs.mkdirSync(path.join(dir, 'data/notebook'));
  fs.writeFileSync(path.join(dir, 'outside.md'), 'private');
  fs.symlinkSync(path.join(dir, 'outside.md'), path.join(dir, 'data/notebook/link.md'));
  const result = await request('/api/note?p=link.md');
  assert.notEqual(result.status, 200);
  assert.notEqual(result.body.text, 'private');
});

test('chat does not report success when conversation cannot be saved', async t => {
  const {request, dir} = await fixture(t, {}, {reply: async () => ({text:'fixture reply'})}, false, '12345');
  fs.mkdirSync(path.join(dir, 'data/panel-chat-tail.jsonl'));
  const result = await request('/api/chat/send', 'POST', {text:'fixture'});
  assert.equal(result.body.ok, false);
  assert.equal(result.body.unknown, true);
});

test('chat refuses unavailable brain without writing fabricated messages', async t => {
  const { request, dir } = await fixture(t);
  const result = await request('/api/chat/send', 'POST', {text:'example'});
  assert.equal(result.body.ok, false);
  assert.equal(fs.existsSync(path.join(dir, 'data/panel-chat-tail.jsonl')), false);
});

test('clearing chat does not resurrect legacy conversation on next snapshot', async t => {
  const turn = JSON.stringify({where:'panel:12345', text:'example', reply:'reply', t:1});
  const { request } = await fixture(t, {'turns.jsonl': turn + '\n'}, null, false, '12345');
  assert.equal((await request('/api/snapshot')).body.chat.rows.length, 2);
  assert.equal((await request('/api/chat/clear', 'POST')).body.ok, true);
  assert.equal((await request('/api/snapshot')).body.chat.rows.length, 0);
});

test('live unblock updates guard cache and disk and preserves history', async t => {
  const users = {users:{'42':{name:'example',strikes:5,disliked:true}}};
  const {request, dir, respectGuard} = await fixture(t, {'respect.json':JSON.stringify(users)}, null, true);
  assert.equal(respectGuard.handleIncoming({userId:'42'}).blocked, true);
  const result = await request('/api/respect/unblock?uid=42', 'POST');
  assert.equal(result.body.ok, true);
  assert.equal(respectGuard.handleIncoming({userId:'42'}).blocked, false);
  const saved = JSON.parse(fs.readFileSync(path.join(dir,'data/respect.json'))).users['42'];
  assert.equal(saved.disliked, false);
  assert.equal(saved.everDisliked, true);
  assert.equal(saved.strikes, 0);
});

test('bridge reports actual connection or unknown, never panel pid as bridge', async t => {
  const a = await fixture(t);
  assert.equal((await a.request('/api/snapshot')).body.bridge.alive, null);
  const b = await fixture(t, {}, null, true);
  assert.equal((await b.request('/api/snapshot')).body.bridge.alive, false);
});

test('unblock write failure leaves active guard blocked and reports failure', async t => {
  const users = {users:{'42':{name:'example',strikes:5,disliked:true}}};
  const {request, dir, respectGuard} = await fixture(t, {'respect.json':JSON.stringify(users)}, null, true);
  assert.equal(respectGuard.handleIncoming({userId:'42'}).blocked, true);
  fs.renameSync(path.join(dir,'data/respect.json'), path.join(dir,'data/backup.json'));
  fs.mkdirSync(path.join(dir,'data/respect.json'));
  const result = await request('/api/respect/unblock?uid=42', 'POST');
  assert.equal(result.body.ok, false);
  assert.equal(respectGuard.handleIncoming({userId:'42'}).blocked, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'data/backup.json'))).users['42'].disliked, true);
});

test('mood controls update the live session and snapshot for each tier', async t => {
  const {request, dir} = await fixture(t, {'mood.json':'{}'});
  const {getSessionMood} = await import(pathToFileURL(path.join(dir,'src/mood.js')).href);
  for (let tier = 0; tier <= 6; tier++) {
    const result = await request('/api/set?kind=mood&value='+tier, 'POST');
    assert.equal(result.body.ok, true);
    const live = getSessionMood(path.join(dir,'data'), 'private:578021239');
    assert.equal(live.isDynamic, true);
    assert.equal((await request('/api/snapshot')).body.mood.owner.tier, tier);
  }
});

test('mood reset and undo change the active session as well as its snapshot', async t => {
  const {request, dir} = await fixture(t, {'mood.json':'{}'});
  const {getSessionMood} = await import(pathToFileURL(path.join(dir,'src/mood.js')).href);
  await request('/api/set?kind=mood&value=5', 'POST');
  assert.equal((await request('/api/reset?target=mood', 'POST')).body.ok, true);
  assert.equal((await request('/api/snapshot')).body.mood.owner.tier, 3);
  assert.equal(getSessionMood(path.join(dir,'data'), 'private:578021239').key, 'calm');
  assert.equal((await request('/api/undo?target=mood', 'POST')).body.ok, true);
  assert.equal((await request('/api/snapshot')).body.mood.owner.tier, 5);
  assert.equal(getSessionMood(path.join(dir,'data'), 'private:578021239').key, 'happy');
});

test('mood reset undo restores absence of an original session file', async t => {
  const {request, dir} = await fixture(t, {'mood.json':'{}'});
  assert.equal((await request('/api/reset?target=mood', 'POST')).body.ok, true);
  assert.equal((await request('/api/undo?target=mood', 'POST')).body.ok, true);
  assert.equal(fs.existsSync(path.join(dir,'data/session_moods.json')), false);
});

test('tarot reroll reports failure when cards are unavailable', async t => {
  const {request} = await fixture(t);
  const result = await request('/api/tarot/reroll', 'POST');
  assert.equal(result.body.ok, false);
});

test('tarot reroll stores the actual card and respects the switch', async t => {
  const card = {id: 0, name: '测试牌', title: '测试', pos:{today:'正'}, rev:{today:'逆'}};
  const {request, dir} = await fixture(t, {'tarot-cards.json':JSON.stringify({cards:[card]})});
  const roll = await request('/api/tarot/reroll', 'POST');
  assert.equal(roll.body.ok, true);
  const saved = JSON.parse(fs.readFileSync(path.join(dir,'data/tarot.json')));
  assert.equal(saved.name, roll.body.name);
  assert.equal(saved.orientation, roll.body.orientation);
  await request('/api/tarot?enabled=0', 'POST');
  assert.equal((await request('/api/tarot/reroll', 'POST')).body.ok, false);
});

test('activity does not fabricate an intention to publish or comment', async t => {
  const {request} = await fixture(t, {'current-activity.json':JSON.stringify({type:'bili',at:Date.now(),title:'test',up:'test'})});
  const intents = (await request('/api/snapshot')).body.intents;
  assert.equal(intents.some(x => /弹幕|评论/.test(x.text)), false);
});

test('warning strikes alone are not displayed as blacklisted', async t => {
  const users = {users:{'42':{name:'example',strikes:3,disliked:false}}};
  const {request} = await fixture(t, {'respect.json':JSON.stringify(users), 'people.json':JSON.stringify({'42':{name:'example'}})}, null, true);
  const snap = (await request('/api/snapshot')).body;
  assert.equal(snap.relationships.nodes.find(n => n.id === '42').tier, 'warning');
});


test('mood edit rejects malformed session data without modifying mood', async t => {
  const original = '{"byKey":{}}';
  const {request, dir} = await fixture(t, {'mood.json':original, 'session_moods.json':'broken'});
  const result = await request('/api/set?kind=mood&value=5', 'POST');
  assert.notEqual(result.body.ok, true);
  assert.equal(fs.readFileSync(path.join(dir,'data/mood.json'),'utf8'), original);
  assert.equal(fs.readFileSync(path.join(dir,'data/session_moods.json'),'utf8'), 'broken');
});

test('undo with missing backup fails without consuming undo or partially restoring', async t => {
  const {request, dir} = await fixture(t, {'mood.json':'{}', 'session_moods.json':'{}'});
  assert.equal((await request('/api/reset?target=mood','POST')).body.ok,true);
  const undoPath = path.join(dir,'data/undo.json');
  const beforeUndo = fs.readFileSync(undoPath,'utf8');
  const undo = JSON.parse(beforeUndo);
  fs.rmSync(undo.mood.items[1].backup);
  const moodBefore = fs.readFileSync(path.join(dir,'data/mood.json'),'utf8');
  const result = await request('/api/undo?target=mood','POST');
  assert.notEqual(result.body.ok,true);
  assert.equal(fs.readFileSync(path.join(dir,'data/mood.json'),'utf8'),moodBefore);
  assert.equal(fs.readFileSync(undoPath,'utf8'),beforeUndo);
});


test('second mood commit failure rolls back both files', async t => {
  const mood = '{"byKey":{}}', sessions = '{}';
  const {request, dir} = await fixture(t, {'mood.json':mood, 'session_moods.json':sessions});
  const rename = fs.renameSync;
  fs.renameSync = function(src, dest) { if (dest === path.join(dir,'data/session_moods.json')) throw new Error('injected failure'); return rename.apply(this, arguments); };
  let result;
  try { result = await request('/api/set?kind=mood&value=5','POST'); } finally { fs.renameSync = rename; }
  assert.notEqual(result.body.ok,true);
  assert.equal(fs.readFileSync(path.join(dir,'data/mood.json'),'utf8'),mood);
  assert.equal(fs.readFileSync(path.join(dir,'data/session_moods.json'),'utf8'),sessions);
});

test('personality reset and undo restore exact originals and absent files', async t => {
  for (const files of [{'mbti.json':'{"code":"INTJ"}', 'mbti-behavior.jsonl':'{"type":"x"}\n'}, {'mbti-behavior.jsonl':'{"type":"x"}\n'}]) {
    const {request,dir} = await fixture(t, files);
    assert.equal((await request('/api/reset?target=mbti','POST')).body.ok,true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'data/mbti.json'))).code,null);
    assert.equal(fs.readFileSync(path.join(dir,'data/mbti-behavior.jsonl'),'utf8'),'');
    assert.equal((await request('/api/undo?target=mbti','POST')).body.ok,true);
    for (const name of ['mbti.json','mbti-behavior.jsonl']) {
      if (name in files) assert.equal(fs.readFileSync(path.join(dir,'data',name),'utf8'),files[name]);
      else assert.equal(fs.existsSync(path.join(dir,'data',name)),false);
    }
  }
});

test('relationship graph preserves measured interactions and blacklisting', async t => {
 const people = {'42':{name:'A',dialogues:4,messagesSeen:7}, '43':{name:'B',dialogues:2}};
 const respect = {users:{'43':{disliked:true,reason:'harass',strikes:5}}};
 const {request} = await fixture(t, {'people.json':JSON.stringify(people),'respect.json':JSON.stringify(respect),'relationships.json':JSON.stringify({'42':{intimacy:33,trust:66}})});
 const graph = (await request('/api/snapshot')).body.relationships;
 const a = graph.nodes.find(n=>n.id==='42'), b = graph.nodes.find(n=>n.id==='43');
 assert.equal(a.dialogues,4); assert.equal(a.messagesSeen,7); assert.equal(a.intimacy,33); assert.equal(a.trust,66);
 assert.equal(b.tier,'disliked'); assert.equal(b.disliked,true);
 assert.equal(graph.links.some(l=>l.source==='self' && l.target==='42'),true);
});


test('empty mood state can be set and reflects the selected tier', async t => {
  const {request} = await fixture(t);
  assert.equal((await request('/api/set?kind=mood&value=5', 'POST')).body.ok, true);
  assert.equal((await request('/api/snapshot')).body.mood.owner.tier, 5);
});

test('empty mood state reset and undo restores absence', async t => {
  const {request, dir} = await fixture(t);
  assert.equal((await request('/api/reset?target=mood', 'POST')).body.ok, true);
  assert.equal((await request('/api/snapshot')).body.mood.owner.tier, 3);
  assert.equal((await request('/api/undo?target=mood', 'POST')).body.ok, true);
  for (const name of ['mood.json', 'session_moods.json']) assert.equal(fs.existsSync(path.join(dir, 'data', name)), false);
});

test('malformed mood state is preserved by set and reset', async t => {
  for (const name of ['mood.json', 'session_moods.json']) {
    for (const value of ['[1]', 'null', '{broken', '{"byKey":[]}']) {
      if (name === 'session_moods.json' && value === '{"byKey":[]}') continue;
      const {request, dir} = await fixture(t, {[name]:value});
      for (const endpoint of ['/api/set?kind=mood&value=2', '/api/reset?target=mood']) {
        assert.equal((await request(endpoint, 'POST')).body.ok, false, name + ':' + value);
        assert.equal(fs.readFileSync(path.join(dir, 'data', name), 'utf8'), value);
      }
    }
  }
});


test('relationship layout survives snapshot refresh and a refresh during drag', async () => {
  const vm = await import('node:vm');
  const source = fs.readFileSync(path.join(root, 'scripts/panel.mjs'), 'utf8');
  const render = source.slice(source.indexOf('function renderRelations(rel){'), source.indexOf('function initRelEvents(cvs){'));
  const context = vm.createContext({ REL_DATA:null, REL_SELECTED:null, REL_INITED:true, REL_DRAG_NODE:null, el: id => id === 'relCanvas' ? {} : null, layoutAndDrawRel:()=>{}, showRelDetail:()=>{} });
  vm.runInContext(render, context);
  const node = {id:'self',x:20,y:30,r:26};
  context.renderRelations({nodes:[node]});
  context.REL_DRAG_NODE = node;
  const next = {id:'self'};
  context.renderRelations({nodes:[next]});
  assert.equal(next.x, 20);
  assert.equal(next.y, 30);
  assert.equal(context.REL_DRAG_NODE, next);
});


test('empty state reports absent mood and baseline-only personality honestly', async t => {
  const {request} = await fixture(t);
  const s = (await request('/api/snapshot')).body;
  assert.equal(s.mood.owner.source, 'default');
  assert.equal(s.mbti.source, 'baseline');
  assert.equal(s.virtue, null);
});


test('empty focus does not claim an activity is happening', async t => {
  const {request} = await fixture(t);
  const s = (await request('/api/snapshot')).body;
  assert.equal(s.focus.current, null);
  assert.equal(s.focus.platform, null);
});


test('derived personality does not claim an unsaved self identity', async t => {
  const {request} = await fixture(t, {'virtue.json':JSON.stringify({version:2,axes:{'诚实':4},decayAt:Date.now()})});
  const m = (await request('/api/snapshot')).body.mbti;
  assert.equal(m.source,'derived');
  assert.equal(m.selfClaimSource,'unverified');
});


test('panel markup has exactly one tarot rules element', async t => {
  const {dir} = await fixture(t);
  const panel = fs.readFileSync(path.join(dir, 'scripts/panel.mjs'), 'utf8');
  assert.equal((panel.match(/id="tarotRules"/g) || []).length, 1);
});
