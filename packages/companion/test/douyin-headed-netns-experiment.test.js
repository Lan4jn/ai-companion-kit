import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { spawn } from 'node:child_process';

// A network namespace is a second, OS-enforced boundary. This experiment is
// deliberately separate from production: it does not provide a usable egress
// proxy and therefore must not be used to enable the headed login daemon.
test('isolated Chromium cannot reach a host HTTP listener even through a fulfilled redirect or websocket', {timeout: 45000}, async () => {
  const lan = Object.values(networkInterfaces()).flat().find(x => x && x.family === 'IPv4' && !x.internal)?.address;
  assert.ok(lan, 'host IPv4 required for this isolation test');
  let hits = 0;
  const server = createServer((_req, res) => { hits++; res.end('host reached'); });
  server.on('upgrade', socket => { hits++; socket.destroy(); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '0.0.0.0', resolve); });
  const port = server.address().port;
  const code = `
    const {chromium} = require('playwright-core');
    const net = require('node:net');
    (async () => {
      const host = process.argv[1], port = Number(process.argv[2]);
      const direct = await new Promise(resolve => {
        const s = net.connect({host, port});
        s.setTimeout(2000, () => { s.destroy(); resolve(false); });
        s.on('connect', () => { s.destroy(); resolve(true); });
        s.on('error', () => resolve(false));
      });
      if (direct) throw Error('namespace allows direct host TCP');
      const browser = await chromium.launch({headless:true, executablePath:'/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome', args:['--no-sandbox']});
      try {
        const context = await browser.newContext({serviceWorkers:'block'});
        await context.route('https://example.com/', r => r.fulfill({status:302, headers:{location:'http://' + host + ':' + port + '/redirect'}}));
        const page = await context.newPage();
        await page.goto('https://example.com/', {timeout:5000}).catch(() => {});
        await page.goto('http://' + host + ':' + port + '/direct', {timeout:5000}).catch(() => {});
        const wsPage = await context.newPage();
        const ws = await wsPage.evaluate(({host,port}) => new Promise(resolve => {
          const s = new WebSocket('ws://' + host + ':' + port + '/ws');
          const timer = setTimeout(() => { s.close(); resolve('timeout'); }, 2000);
          s.onopen = () => { clearTimeout(timer); s.close(); resolve('open'); };
          s.onerror = () => { clearTimeout(timer); resolve('error'); };
        }), {host,port});
        if (ws === 'open') throw Error('namespace allows host WebSocket');
        console.log(JSON.stringify({direct, ws}));
      } finally { await browser.close(); }
    })().catch(e => { console.error(e.stack); process.exitCode=1; });`;
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn('unshare', ['--net', process.execPath, '-e', code, lan, String(port)], {stdio:['ignore','pipe','pipe']});
      let stdout='', stderr=''; child.stdout.on('data', x => stdout += x); child.stderr.on('data', x => stderr += x);
      child.on('error', reject); child.on('close', status => resolve({status,stdout,stderr}));
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout.trim()).direct, false);
    assert.equal(hits, 0, 'host listener must never receive requests');
  } finally { await new Promise(resolve => server.close(resolve)); }
});
