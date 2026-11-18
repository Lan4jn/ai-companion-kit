import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import dns from 'node:dns/promises';
import https from 'node:https';
import { chromium } from 'playwright-core';
import { installDouyinRequestGuard } from '../src/douyin-navigation-safety.js';

test('redirect hops are revalidated, bounded, and unsafe methods never reach the server', async () => {
  const oldLookup = dns.lookup, oldRequest = https.request;
  const calls = [];
  dns.lookup = async host => host === 'www.douyin.com' ? [{address:'127.0.0.1',family:4}] : [{address:'8.8.8.8',family:4}];
  https.request = (url, opts, cb) => {
    calls.push({url:url.href, method:opts.method});
    const req = new EventEmitter(); req.destroy = () => {};
    req.end = () => queueMicrotask(() => {
      const res = new EventEmitter(); res.statusCode = 302;
      res.headers = {location: url.pathname.includes('abc') ? 'https://www.douyin.com/video/123' : 'https://v.douyin.com/loop/'};
      cb(res); res.emit('end');
    });
    return req;
  };
  let browser;
  try {
    browser = await chromium.launch({headless:true, executablePath:'/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome',args:['--no-sandbox','--host-resolver-rules=MAP * 127.0.0.1','--disable-background-networking']});
    const context = await browser.newContext({serviceWorkers:'block'});
    await installDouyinRequestGuard(context);
    const page = await context.newPage();
    await page.goto('https://v.douyin.com/abc/', {timeout:5000}).catch(() => {});
    await page.waitForTimeout(500);
    assert.deepEqual(calls.map(c => c.url), ['https://v.douyin.com/abc/']);
    calls.length = 0;
    await page.goto('https://v.douyin.com/loop/', {timeout:5000}).catch(() => {});
    await page.waitForTimeout(1500);
    assert.ok(calls.filter(c => c.url === 'https://v.douyin.com/loop/').length > 0 && calls.filter(c => c.url === 'https://v.douyin.com/loop/').length <= 6, `unbounded redirects: ${JSON.stringify(calls)}`);
    calls.length = 0;
    await page.setContent('<html></html>');
    await page.evaluate(() => fetch('https://v.douyin.com/abc/', {method:'POST',body:'x'}).catch(() => {}));
    assert.equal(calls.length, 0);
    await context.close();
  } finally { await browser?.close(); dns.lookup = oldLookup; https.request = oldRequest; }
});
