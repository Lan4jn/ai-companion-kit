import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixtureCandidate, createFixtureReaderSource } from '../src/tieba-login-candidate-fixture.js';
import { createTiebaReader } from '../src/tieba-reader.js';

test('actual reader uses the authenticated fixture candidate session', async t => {
  const root = await mkdtemp(join(process.env.TMPDIR, 'tieba-shared-reader-'));
  let candidate;
  t.after(async () => { await candidate?.close(); await rm(root, { recursive: true, force: true }); });
  candidate = await createFixtureCandidate({ root });
  const source = createFixtureReaderSource(candidate);
  let prompts = 0;
  const reader = createTiebaReader({ enabled: true, source, dir: root, brain: { complete: async ({prompt}) => {
    prompts++;
    assert.match(prompt, /fixture forum content/);
    return JSON.stringify({action:'continue',record:false,keywords:[]});
  } } });
  assert.equal((await reader.run()).status, 'source_failed');
  await candidate.login();
  assert.deepEqual(await reader.run(), {status:'completed',read:1,saved:0});
  assert.equal(prompts, 1);
  await candidate.close();
  assert.equal((await reader.run()).status, 'source_failed');
});
