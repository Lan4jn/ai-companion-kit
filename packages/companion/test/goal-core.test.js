import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createGoalCore } from '../src/goal-core.js';

const dir = () => fs.mkdtempSync(path.join(process.env.TMPDIR || '/root/.hermes/cache/scratch', 'goal-core-test-'));

test('evidence-backed events update goals and survive reopening without duplicate application', () => {
  const file = path.join(dir(), 'state.json');
  const core = createGoalCore({ file });
  core.addGoal({ id: 'learn', title: '学习', target: 2 });
  const event = { id: 'e1', type: 'goal.progress', goalId: 'learn', amount: 1, evidence: { source: 'video-log', ref: 'v1' } };
  assert.equal(core.record(event).applied, true);
  assert.equal(core.record(event).applied, false);
  assert.equal(createGoalCore({ file }).snapshot().goals.learn.progress, 1);
});

test('desires may be refused and successful outcomes require evidence', () => {
  const file = path.join(dir(), 'state.json');
  const core = createGoalCore({ file });
  core.addGoal({ id: 'g1', title: '学习', target: 1 });
  core.addDesire({ id: 'd1', title: '学习攻略', goalId: 'g1' });
  assert.throws(() => core.record({ id: 'bad', type: 'desire.completed', desireId: 'd1' }), /evidence/);
  core.record({ id: 'reject', type: 'desire.refused', desireId: 'd1', reason: '不想做' });
  assert.equal(createGoalCore({ file }).snapshot().desires.d1.status, 'refused');
  assert.throws(() => core.record({ id: 'again', type: 'desire.completed', desireId: 'd1', evidence: { source: 'test', ref: '1' } }), /closed/);
});

test('a completed desire advances its linked goal once using observed amount', () => {
  const file = path.join(dir(), 'state.json');
  const core = createGoalCore({ file });
  core.addGoal({ id: 'g', title: '学习', target: 3 });
  core.addDesire({ id: 'd', title: '看攻略', goalId: 'g' });
  const event = { id: 'done', type: 'desire.completed', desireId: 'd', amount: 2, evidence: { source: 'watch-log', ref: 'video-1' } };
  core.record(event);
  core.record(event);
  assert.equal(core.snapshot().goals.g.progress, 2);
  assert.equal(core.snapshot().desires.d.status, 'completed');
});

test('invalid and conflicting events leave persisted state unchanged', () => {
  const file = path.join(dir(), 'state.json');
  const core = createGoalCore({ file });
  core.addGoal({ id: 'g', title: '目标', target: 2 });
  const before = core.snapshot();
  for (const event of [
    { id: 'a', type: 'goal.progress', goalId: 'g', amount: 1 },
    { id: 'b', type: 'goal.progress', goalId: 'g', amount: -1, evidence: { source: 's', ref: 'r' } },
    { id: 'c', type: 'goal.progress', goalId: 'missing', amount: 1, evidence: { source: 's', ref: 'r' } },
  ]) assert.throws(() => core.record(event));
  assert.deepEqual(core.snapshot(), before);
  const event = { id: 'ok', type: 'goal.progress', goalId: 'g', amount: 5, evidence: { source: 's', ref: 'r' } };
  core.record(event);
  assert.equal(core.snapshot().goals.g.progress, 2);
  assert.equal(core.snapshot().goals.g.status, 'completed');
  assert.throws(() => core.record({ ...event, amount: 1 }), /conflict/);
});

test('corrupt persisted state is not silently reset', () => {
  const file = path.join(dir(), 'state.json');
  fs.writeFileSync(file, '{broken');
  const core = createGoalCore({ file });
  assert.throws(() => core.snapshot(), SyntaxError);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});
