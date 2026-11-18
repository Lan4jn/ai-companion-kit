import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatterLearner } from '../src/chatter-learner.js';

test('stop waits for in-flight learning and blocks delayed work', async () => {
  const dir = mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'learner-stop-'));
  let release, started;
  const entered = new Promise(r => { started = r; });
  const brain = { complete: () => { started(); return new Promise(r => { release = r; }); } };
  const memory = { recentGroupChatter: () => Array.from({length: 12}, () => ({name:'x', text:'hello'})), logDiary() {} };
  const learner = new ChatterLearner({dataDir:dir, brain, memory, minGapMs:0});
  try {
    const learning = learner.learnOnce({force:true});
    await entered;
    let stopped = false;
    const stop = Promise.resolve(learner.stop()).then(() => { stopped = true; });
    await new Promise(r => setImmediate(r));
    assert.equal(stopped, false, 'stop must wait for model and file writes');
    release(JSON.stringify({learnedHabits:['测试群友习惯']}));
    await Promise.all([stop, learning]);
    assert.equal(existsSync(path.join(dir, 'human-insights.json')), true);
    assert.equal(await learner.learnOnce({force:true}), false, 'stopped learner rejects new work');
  } finally { release?.('{}'); await learner.stop(); rmSync(dir,{recursive:true,force:true}); }
});
