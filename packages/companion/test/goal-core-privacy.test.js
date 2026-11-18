import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const moduleUrl = new URL('../src/goal-core.js', import.meta.url).href;

test('event text is transferred without appearing in process arguments', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/root/.hermes/cache/scratch', 'goal-private-'));
  try {
    const marker = 'PRIVATE_OCR_CONTENT_1a9f';
    const flock = path.join(dir, 'flock');
    fs.writeFileSync(flock, `#!/bin/sh\nfor arg do\n  case "$arg" in *${marker}*) exit 77;; esac\ndone\nexec /usr/bin/flock "$@"\n`, { mode: 0o700 });
    const script = `import { createGoalCore } from ${JSON.stringify(moduleUrl)};
      const core = createGoalCore({file:process.argv[1]});
      core.addGoal({id:'g', title:'goal', target:2});
      const event = {id:'e', type:'goal.progress', goalId:'g', amount:1, evidence:{source:'ocr', ref:'r', content:${JSON.stringify(marker)} + 'x'.repeat(200000)}};
      if (!core.record(event).applied || core.record(event).applied) process.exit(3);
      if (core.snapshot().events.e.evidence.content !== event.evidence.content) process.exit(4);`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, path.join(dir, 'state.json')], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, `transaction failed: ${result.error?.message || result.stderr}`);
    assert.equal(result.stdout.includes(marker), false);
    assert.equal(result.stderr.includes(marker), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
