import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { saveFanqieMemory, recallFanqie } from '../src/fanqie-session.js';

test('specific reading recall does not treat summary-only legacy records as read passages', async t => {
  const dir = await fs.mkdtemp(path.join(process.env.TMPDIR, 'fanqie-summary-only-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await saveFanqieMemory(dir, { source: 'OCR', summary: '古城下雨', keywords: ['古城'], fingerprint: 'legacy' });
  await saveFanqieMemory(dir, { source: 'OCR', text: '古城的夜空落下细雨', summary: '古城下雨', keywords: ['古城'], fingerprint: 'observed' });
  const rows = await recallFanqie(dir, '古城');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, '古城的夜空落下细雨');
});
