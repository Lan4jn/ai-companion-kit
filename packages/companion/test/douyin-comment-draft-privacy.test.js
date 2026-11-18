import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { submitDouyinComment, sendDouyinCommentOnce } from '../src/douyin-living.js';

test('existing private draft cannot be appended to and submitted as a vetted public comment', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-draft-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const browser = await chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome', args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<div class="comment-input-inner-container"></div><div class="public-DraftEditor-content" contenteditable="true">私聊里的秘密</div><button data-e2e="comment-submit" onclick="window.sent=document.querySelector('.public-DraftEditor-content').innerText">发送</button>`);
  const result = await submitDouyinComment('正常评论', ['123456789'], () => sendDouyinCommentOnce(page, { text: '正常评论', workId: '123', dataDir: dir }));
  assert.notEqual(result?.status, 'unknown');
  assert.equal(await page.evaluate(() => window.sent), undefined);
});
