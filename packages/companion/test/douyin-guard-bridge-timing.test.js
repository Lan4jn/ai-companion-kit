import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import dns from 'node:dns/promises';
import https from 'node:https';
import { chromium } from 'playwright-core';
import { installDouyinRequestGuard } from '../src/douyin-navigation-safety.js';

test('bridge fails closed with JavaScript disabled', async () => {
  const oldLookup = dns.lookup, oldRequest = https.request;
  const requests = [];
  dns.lookup = async () => [{address:'8.8.8.8', family:4}];
  https.request = (url, options, callback) => {
    requests.push(url.href);
    const request = new EventEmitter();
    request.destroy = () => {};
    request.end = () => queueMicrotask(() => {
      const response = new EventEmitter();
      response.statusCode = 302;
      response.headers = {location:'https://www.douyin.com/video/123'};
      callback(response); response.emit('end');
    });
    return request;
  };
  let browser;
  try {
    browser = await chromium.launch({headless:true, executablePath:'/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome', args:['--no-sandbox']});
    const context = await browser.newContext({serviceWorkers:'block', javaScriptEnabled:false});
    await installDouyinRequestGuard(context);
    const page = await context.newPage();
    await page.goto('https://v.douyin.com/abc/', {waitUntil:'domcontentloaded', timeout:5000});
    assert.equal(page.url(), 'https://v.douyin.com/abc/');
    assert.deepEqual(requests, ['https://v.douyin.com/abc/']);
    await context.close();
  } finally { await browser?.close(); dns.lookup = oldLookup; https.request = oldRequest; }
});

test('goto waits for the final guarded document even when its response is delayed', async () => {
  const oldLookup = dns.lookup, oldRequest = https.request;
  dns.lookup = async () => [{address:'8.8.8.8', family:4}];
  https.request = (url, options, callback) => {
    const request = new EventEmitter();
    request.destroy = () => {};
    request.end = () => setTimeout(() => {
      const response = new EventEmitter();
      const redirect = url.hostname === 'v.douyin.com';
      response.statusCode = redirect ? 302 : 200;
      response.headers = redirect ? {location:'https://www.douyin.com/video/123'} : {'content-type':'text/html'};
      callback(response);
      if (!redirect) response.emit('data', Buffer.from('<html><body>final document</body></html>'));
      response.emit('end');
    }, url.hostname === 'v.douyin.com' ? 0 : 1200);
    return request;
  };
  let browser;
  try {
    browser = await chromium.launch({headless:true, executablePath:'/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome', args:['--no-sandbox']});
    const context = await browser.newContext({serviceWorkers:'block'});
    await installDouyinRequestGuard(context);
    const page = await context.newPage();
    await page.goto('https://v.douyin.com/abc/', {waitUntil:'domcontentloaded', timeout:5000});
    assert.equal(page.url(), 'https://www.douyin.com/video/123');
    assert.equal(await page.locator('body').innerText(), 'final document');
    await context.close();
  } finally { await browser?.close(); dns.lookup = oldLookup; https.request = oldRequest; }
});
