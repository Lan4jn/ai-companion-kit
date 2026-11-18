import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublicIPv4, resolvePublicIPv4, fetchPinned, isAllowedRequest } from '../src/tieba-playwright.js';
import { chromium } from 'playwright-core';
import http from 'node:http';

test('rejects non-global IPv4 and a rebinding/mixed DNS answer', async () => {
  for (const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','100.64.0.1','192.0.2.1','198.18.0.1','224.0.0.1','0.0.0.0','::1','::ffff:8.8.8.8']) assert.equal(isPublicIPv4(ip), false, ip);
  assert.equal(isPublicIPv4('8.8.8.8'), true);
  await assert.rejects(resolvePublicIPv4('tieba.baidu.com', async () => ['8.8.8.8', '127.0.0.1']));
  assert.equal(await resolvePublicIPv4('tieba.baidu.com', async () => ['8.8.8.8']), '8.8.8.8');
});

test('pinned transport refuses mixed public/private DNS before connecting', async () => {
  const req = {url: () => 'https://tieba.baidu.com/p/1', method: () => 'GET'};
  await assert.rejects(fetchPinned(req, 1000, undefined, async () => ['8.8.8.8', '127.0.0.1']), /unsafe_dns/);
});

test('browser policy blocks navigation, write and websocket candidates', () => {
  const request = (url, method, type, nav = false) => ({ url: () => url, method: () => method, resourceType: () => type, isNavigationRequest: () => nav });
  for (const req of [request('https://tieba.baidu.com/p/2','GET','document',true), request('https://127.0.0.1/','GET','image'), request('https://tieba.baidu.com/c/c/post/add','POST','xhr'), request('wss://tieba.baidu.com/','GET','websocket')]) assert.equal(isAllowedRequest(req, 'https://tieba.baidu.com/p/1'), false);
});

test('browser blocks local network and websocket', async () => {
  let hits = 0;
  const server = http.createServer((req, res) => { hits++; res.end('bad'); });
  server.on('upgrade', socket => { hits++; socket.destroy(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/root/.hermes/tools/chromium-1208/chrome-linux64/chrome', headless: true, proxy: { server: 'http://tieba-block.invalid:9', bypass: '<-loopback>' }, args: ['--no-sandbox','--disable-background-networking','--disable-quic','--force-webrtc-ip-handling-policy=disable_non_proxied_udp','--host-resolver-rules=MAP * ~NOTFOUND'] });
  try {
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    await ctx.route('**/*', route => route.abort());
    await ctx.routeWebSocket('**/*', ws => ws.close());
    const page = await ctx.newPage();
    await page.setContent(`<img src="http://127.0.0.1:${port}/image"><script>fetch('http://127.0.0.1:${port}/fetch').catch(()=>{}); new WebSocket('ws://127.0.0.1:${port}/ws');</script>`);
    await page.waitForTimeout(500);
    assert.equal(hits, 0);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});
