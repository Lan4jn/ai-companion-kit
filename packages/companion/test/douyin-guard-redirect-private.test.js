import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import dns from 'node:dns/promises';
import https from 'node:https';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { installDouyinRequestGuard } from '../src/douyin-navigation-safety.js';

test('redirect to a private address is blocked before any socket is opened', async () => {
  const server = http.createServer((_req, res) => { hits++; res.end('unexpected'); });
  let hits = 0, browser;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const oldLookup = dns.lookup, oldRequest = https.request;
  dns.lookup = async () => [{ address: '8.8.8.8', family: 4 }];
  https.request = (_url, _opts, callback) => {
    const req = new EventEmitter();
    req.end = () => queueMicrotask(() => {
      const res = new EventEmitter();
      res.statusCode = 302;
      res.headers = { location: `http://127.0.0.1:${server.address().port}/private` };
      callback(res); res.emit('end');
    });
    req.destroy = () => {};
    return req;
  };
  try {
    browser = await chromium.launch({headless:true, executablePath:'/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome', args:['--no-sandbox', '--host-resolver-rules=MAP * 127.0.0.1', '--disable-background-networking']});
    const context = await browser.newContext({serviceWorkers:'block'});
    await installDouyinRequestGuard(context);
    const page = await context.newPage();
    await page.goto('https://v.douyin.com/abc/').catch(() => {});
    assert.equal(hits, 0, 'redirect bypassed the guard and reached private server');
  } finally {
    await browser?.close(); dns.lookup = oldLookup; https.request = oldRequest;
    await new Promise(resolve => server.close(resolve));
  }
});
