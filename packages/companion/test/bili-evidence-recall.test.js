import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as bili from '../src/bili-living.js';
const { recallKnowledge } = bili;
const saveKnowledge = (...args) => bili.saveKnowledge?.(...args) ?? null;

function isolated(t, rows = []) {
  const old = process.env.HOME;
  const home = fs.mkdtempSync(path.join(process.env.TMPDIR, 'bili-evidence-'));
  process.env.HOME = home;
  const file = path.join(home, 'ai-companion-xiaoyu/ai-companion-kit/packages/companion/data/bili-knowledge.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  t.after(() => { process.env.HOME = old; fs.rmSync(home, { recursive:true, force:true }); });
  return file;
}
const vid = { bvid:'BV11T411P7o1', title:'木星养企鹅的奇妙故事', up:'小明', duration:10 };
const observation = {source:'visual',start:0,end:10,quote:'企鹅跳舞'};
const knowledge = { points:[observation] };
const stored = {summary:'',points:['低可信画面模型观察（0-10秒，可能误识）：企鹅跳舞'],tags:[],observations:[observation]};
const evidence = { version:2, sources:['visual','subtitle'], coverage:{ complete:true, duration:10, segments:[{start:0,end:10,visual:'企鹅跳舞',subtitle:'企鹅'}] }, playback:{ complete:true, fullWatchVerified:true, duration:10, start:0, end:10, watched:10, samples:Array.from({length:11},(_,i)=>({time:i,wall:i/2,duration:10,rate:2,identity:true,paused:false,seeking:false,ended:i===10})) } };

test('legacy knowledge cannot be presented as watched evidence', t => {
  isolated(t, [{ ...vid, ...knowledge }]);
  assert.deepEqual(recallKnowledge('你看过BV11T411P7o1视频吗'), []);
});

test('unsupported evidence versions are rejected', t => {
  isolated(t, [{ ...vid, ...knowledge, evidence: {...evidence, version:0} }, {...vid, ...knowledge, evidence:{...evidence, version:3}}]);
  assert.deepEqual(recallKnowledge('BV11T411P7o1'), []);
});

test('save preserves source and playback coverage and requires valid proof', t => {
  isolated(t);
  assert.equal(saveKnowledge(vid, knowledge), null);
  assert.equal(saveKnowledge(vid, knowledge, {...evidence, playback:{...evidence.playback, complete:false}}), null);
  const rec = saveKnowledge(vid, knowledge, evidence);
  assert.equal(rec.evidence.version, 2);
  assert.deepEqual(rec.evidence.sources, ['visual','subtitle']);
  assert.equal(rec.evidence.coverage.segments[0].end, 10);
  assert.equal(recallKnowledge('BV11T411P7o1')[0].bvid, vid.bvid);
});

test('single common trigram cannot identify a different video', t => {
  isolated(t, [{ ...vid, ...stored, evidence }]);
  assert.deepEqual(recallKnowledge('你看过木星养恐龙的那条视频吗'), []);
});

test('a malformed BV never falls back to a matching title', t => {
  isolated(t, [{ ...vid, ...stored, evidence }]);
  assert.deepEqual(recallKnowledge('BV123 木星养企鹅'), []);
});

test('colloquial content lookup finds an exact verified phrase', t => {
  isolated(t, [{ ...vid, ...stored, evidence }]);
  assert.equal(recallKnowledge('你刷到过木星养企鹅那条吗')[0]?.bvid, vid.bvid);
});

test('ambiguous titles are refused and BV is case-sensitive and exact', t => {
  const other = {...vid, bvid:'BV22T411P7o2'};
  isolated(t, [{ ...vid, ...stored, evidence }, {...other, ...stored, evidence}]);
  assert.deepEqual(recallKnowledge('你看过木星养企鹅的奇妙故事吗'), []);
  assert.equal(recallKnowledge('BV22T411P7o2')[0].bvid, other.bvid);
  assert.deepEqual(recallKnowledge('BV22T411P7O2'), []);
});
