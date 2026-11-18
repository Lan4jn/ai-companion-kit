import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import dns from 'node:dns/promises';
import https from 'node:https';
import { chromium } from 'playwright-core';
import { installDouyinRequestGuard } from '../src/douyin-navigation-safety.js';

test('real Chromium follows guarded redirects and receives multiple cookies without leaking them to another host', async () => {
  const oldLookup = dns.lookup, oldRequest = https.request;
  const requests = [];
  dns.lookup = async () => [{ address: '8.8.8.8', family: 4 }];
  https.request = (url, options, callback) => {
    options.lookup(url.hostname, {all: false}, (err, address) => { assert.ifError(err); assert.equal(address, '8.8.8.8'); });
    requests.push({url: url.href, headers: options.headers});
    const req = new EventEmitter();
    req.end = () => queueMicrotask(() => {
      const response = new EventEmitter();
      const redirect = url.hostname === 'v.douyin.com';
      response.statusCode = redirect ? 302 : 200;
      response.headers = redirect ? {location:'https://www.douyin.com/video/123', 'set-cookie':['a=1; Domain=.douyin.com; Secure; Path=/','b=2; Domain=.douyin.com; Secure; Path=/']} : {'content-type':'text/html'};
      callback(response);
      if (!redirect) response.emit('data', Buffer.from('<html>ok</html>'));
      response.emit('end');
    });
    req.destroy = () => {}; return req;
  };
  let browser;
  try {
    browser = await chromium.launch({headless:true, executablePath:'/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome',args:['--no-sandbox']});
    const context = await browser.newContext({serviceWorkers:'block'});
    await installDouyinRequestGuard(context);
    const page = await context.newPage();
    await page.goto('https://v.douyin.com/abc/');
    assert.equal(page.url(), 'https://www.douyin.com/video/123');
    assert.match(requests[1].headers.cookie, /a=1/);
    assert.match(requests[1].headers.cookie, /b=2/);
    await page.evaluate(() => fetch('https://static.byteimg.com/probe', {credentials:'include'}).catch(() => {}));
    const other = requests.find(r => r.url === 'https://static.byteimg.com/probe');
    assert.ok(other);
    assert.equal(other.headers.cookie, undefined);
    await context.close();
  } finally { await browser?.close(); dns.lookup = oldLookup; https.request = oldRequest; }
});
