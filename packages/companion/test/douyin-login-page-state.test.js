import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { decideQrAction } from '../src/douyin-qr-state.js';

const source = fs.readFileSync(new URL('../src/douyin-qr-daemon.js', import.meta.url), 'utf8');
const match = source.match(/pageState = await page\.evaluate\((\(\) => \{[\s\S]*?\n      \})\);/);
assert.ok(match, 'daemon page-state detector must be available');
const detect = Function(`return (${match[1]})`)();

test('feed text cannot trigger a risk challenge while a normal login panel is open', async () => {
  const browser = await chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome', headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent('<main>视频标题：请完成验证，安全验证科普</main><div id="login-panel-new">登录后免费畅享高清视频 扫码登录 验证码登录</div>');
    const state = await page.evaluate(detect);
    assert.equal(state.risk, false);
    assert.equal(state.isQrScreen, true);
    await page.evaluate(() => { document.querySelector('#login-panel-new').textContent = '安全验证 请完成验证'; });
    assert.equal((await page.evaluate(detect)).risk, true);
    await page.evaluate(() => { document.querySelector('#login-panel-new').textContent = '二维码已失效'; });
    const expired = await page.evaluate(detect);
    assert.equal(expired.isExpired, true);
    assert.equal(decideQrAction(expired), 'refresh');
  } finally { await browser.close(); }
});

test('capture rejects expiry and challenges only on visible login surfaces', async () => {
  const match = source.match(/async function saveQRShot\(\) \{[\s\S]*?page\.evaluate\((\(\) => \{[\s\S]*?\n      \})\);/);
  assert.ok(match);
  const inspect = Function(`return (${match[1]})`)();
  const browser = await chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome', headless:true, args:['--no-sandbox'] });
  try {
    const page=await browser.newPage();
    await page.setContent('<main>二维码已失效 安全验证</main><div id="login-panel-new">扫码登录</div>');
    let state=await page.evaluate(inspect); assert.equal(state.expired,false); assert.equal(state.challenged,false);
    for(const text of ['二维码已过期','点击刷新','二维码失效']) {
      await page.locator('#login-panel-new').evaluate((e,t)=>e.textContent=t,text);
      state=await page.evaluate(inspect); assert.equal(state.expired,true,text);
    }
    await page.locator('#login-panel-new').evaluate(e=>e.textContent='安全验证 请完成验证');
    assert.equal((await page.evaluate(inspect)).challenged,true);
  } finally {await browser.close();}
});
