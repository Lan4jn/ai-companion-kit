import test from 'node:test';
import assert from 'node:assert/strict';
import { douyinWorkTarget, douyinRequestAllowed, installDouyinRequestGuard } from '../src/douyin-navigation-safety.js';
import { chromium } from 'playwright-core';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import dns from 'node:dns/promises';

test('short share resolves only to an official work and preserves direct identity', () => {
  assert.equal(douyinWorkTarget('https://v.douyin.com/abc/', 'https://www.douyin.com/video/123?x=1'), 'https://www.douyin.com/video/123?x=1');
  assert.equal(douyinWorkTarget('https://www.douyin.com/video/123', 'https://www.douyin.com/video/999'), null);
  for (const url of ['http://www.douyin.com/video/123','https://www.douyin.com.evil.test/video/123','https://www.douyin.com:444/video/123','https://user@www.douyin.com/video/123','https://127.0.0.1/video/123','https://www.douyin.com/redirect?next=/video/123']) assert.equal(douyinWorkTarget('https://v.douyin.com/abc/',url),null,url);
});

test('offline chromium aborts untrusted navigation and subrequests', async () => {
  const browser = await chromium.launch({headless:true, executablePath:'/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome', args:['--no-sandbox']});
  try {
    const context = await browser.newContext({serviceWorkers:'block'});
    await installDouyinRequestGuard(context);
    const page = await context.newPage();
    let failed = 0; page.on('requestfailed', () => failed++);
    await assert.rejects(page.goto('http://127.0.0.1:12345/private'));
    const page2 = await context.newPage(); page2.on('requestfailed', () => failed++);
    await page2.setContent('<html><body></body></html>');
    assert.equal(await page2.evaluate(async () => { try { await fetch('https://evil.test/private'); return true; } catch { return false; } }), false);
    assert.equal(failed, 2);
    await context.close();
  } finally { await browser.close(); }
});

test('navigation rejects arbitrary and normalized malicious paths before any request', () => {
  for (const url of ['https://www.douyin.com/logout', 'https://v.douyin.com/logout', 'https://v.douyin.com/', 'https://v.douyin.com/abc/../../logout', 'https://v.douyin.com/%61bc/', 'https://www.douyin.com/video/123/../logout', 'https://www.douyin.com/video/123?next=https://evil.test']) {
    assert.equal(douyinRequestAllowed(url, true), false, url);
  }
});

test('real chromium cannot open a local websocket through request guard', async () => {
  const server = http.createServer();
  const wss = new WebSocketServer({server});
  let connections = 0;
  wss.on('connection', socket => { connections++; socket.close(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({headless:true, executablePath:'/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome', args:['--no-sandbox']});
  try {
    const context = await browser.newContext({serviceWorkers:'block'});
    await installDouyinRequestGuard(context);
    const page = await context.newPage();
    await page.setContent('<html></html>');
    const result = await page.evaluate(url => new Promise(resolve => {
      const ws = new WebSocket(url); ws.onopen = () => resolve('open'); ws.onerror = ws.onclose = () => resolve('blocked');
      setTimeout(() => resolve('timeout'), 2000);
    }), `ws://127.0.0.1:${server.address().port}/private`);
    assert.equal(result, 'blocked');
    assert.equal(connections, 0);
    await context.close();
  } finally { await browser.close(); await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve)); }
});

test('guard fails closed without WebSocket routing', async () => {
  await assert.rejects(installDouyinRequestGuard({ route() { throw new Error('must not install partially'); } }), /WebSocket routing required/);
});

test('private or mixed DNS answers abort before network fetch', async () => {
  const original = dns.lookup;
  let handler;
  try {
    await installDouyinRequestGuard({ routeWebSocket: async () => {}, route: async (_, fn) => { handler = fn; } });
    for (const answers of [[{address:'127.0.0.1',family:4}], [{address:'8.8.8.8',family:4},{address:'::1',family:6}]]) {
      dns.lookup = async () => answers;
      let aborted = false;
      await handler({request: () => ({url: () => 'https://www.douyin.com/video/123', isNavigationRequest: () => false, method: () => 'GET'}), abort: async () => { aborted = true; }, fulfill: () => { throw new Error('must not fetch'); }});
      assert.equal(aborted, true);
    }
  } finally { dns.lookup = original; }
});

test('requests cannot navigate or redirect to untrusted or private addresses', () => {
  assert.equal(douyinRequestAllowed('https://v.douyin.com/abc/',true),true);
  assert.equal(douyinRequestAllowed('https://www.douyin.com/video/123',true),true);
  assert.equal(douyinRequestAllowed('https://evil.test/',true),false);
  assert.equal(douyinRequestAllowed('http://127.0.0.1:80/',false),false);
  assert.equal(douyinRequestAllowed('https://evil.test/x',false),false);
});
