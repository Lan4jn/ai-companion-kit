import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { LOGIN_PAGE } from '../src/room-login-page.js';

test('离线模拟 B站扫码状态与禁用的抖音旧入口', async () => {
  const browser=await chromium.launch({executablePath:'/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome',headless:true,args:['--no-sandbox']});
  try {
    const page=await browser.newPage();
    const states=['waiting','challenge','verifying','online']; let index=0, starts=0;
    await page.route('http://fixture.test/**',async route=>{
      const u=new URL(route.request().url());
      if(u.pathname==='/login') return route.fulfill({status:200,contentType:'text/html',body:LOGIN_PAGE});
      if(u.pathname.endsWith('/start')) {starts++;return route.fulfill({json:{state:'waiting'}})}
      if(u.pathname.endsWith('/poll')) return route.fulfill({json:{state:states[Math.min(index++,states.length-1)]}});
      if(u.pathname.endsWith('/status')) return route.fulfill({json:{state:'offline'}});
      if(u.pathname.endsWith('/qr')) return route.fulfill({status:404});
      return route.abort();
    });
    page.on('dialog',d=>d.accept());
    await page.goto('http://fixture.test/login');
    assert.equal(await page.locator('#douyin-start').isDisabled(),true);
    assert.match(await page.locator('#douyin-start').textContent(), /暂不可用/);
    await page.locator('#bili-start').click();
    await page.waitForFunction(()=>document.querySelector('#bili-qr').hidden===false);
    assert.equal(await page.locator('#bili-start').isDisabled(),true);
    await page.waitForFunction(()=>document.querySelector('#bili').textContent.includes('正在等待安全验证'));
    assert.equal(await page.locator('#bili-qr').isHidden(),true);
    assert.equal(await page.locator('#bili-qr').getAttribute('src'),null);
    assert.equal(await page.locator('#bili-start').isDisabled(),true);
    await page.waitForFunction(()=>document.querySelector('#bili').textContent.includes('正在验证登录状态'));
    assert.equal(await page.locator('#bili-start').isDisabled(),true);
    await page.waitForFunction(()=>document.querySelector('#bili').textContent.includes('已登录（平台验证通过）'));
    assert.equal(await page.locator('#bili-start').isDisabled(),false);
    assert.equal(await page.locator('#douyin-start').isDisabled(),true);
    assert.equal(starts,1);
  } finally { await browser.close(); }
});
