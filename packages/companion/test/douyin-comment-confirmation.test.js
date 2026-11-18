import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as living from '../src/douyin-living.js';
const sendDouyinCommentOnce = (...args) => typeof living.sendDouyinCommentOnce === 'function' ? living.sendDouyinCommentOnce(...args) : { status: 'missing' };

function fake({ editor = true, clickError = false } = {}) {
  const calls = [];
  return { calls, keyboard: { type: async () => calls.push('type') },
    evaluate: async () => editor, waitForTimeout: async () => {},
    locator: () => ({ first: () => ({ count: async () => 1, click: async () => { calls.push('submit'); if (clickError) throw Error('uncertain'); } }) }) };
}
function temp(t) { const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'dy-comment-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }

test('cleared editor is not proof; repeat is blocked across calls', async t => {
  const dir = temp(t), page = fake();
  assert.equal((await sendDouyinCommentOnce(page, { text: '你好', workId: '123', dataDir: dir })).status, 'unknown');
  assert.equal((await sendDouyinCommentOnce(page, { text: '你好', workId: '123', dataDir: dir })).status, 'blocked');
  assert.equal(page.calls.filter(x => x === 'submit').length, 1);
});

test('missing editor fails before any submission and allows later attempt', async t => {
  const dir = temp(t), page = fake({ editor: false });
  assert.equal((await sendDouyinCommentOnce(page, { text: '你好', workId: '123', dataDir: dir })).status, 'failed');
  assert.equal((await sendDouyinCommentOnce(fake(), { text: '你好', workId: '123', dataDir: dir })).status, 'unknown');
});

test('submit exception remains unknown and is not retried', async t => {
  const dir = temp(t), page = fake({ clickError: true });
  assert.equal((await sendDouyinCommentOnce(page, { text: '你好', workId: '123', dataDir: dir })).status, 'unknown');
  assert.equal((await sendDouyinCommentOnce(page, { text: '你好', workId: '123', dataDir: dir })).status, 'blocked');
});
