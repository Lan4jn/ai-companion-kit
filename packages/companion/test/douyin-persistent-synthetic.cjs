'use strict';
// Offline synthetic experiment only. No real site, account, relay, or production data.
const { chromium } = require('/fixture/playwright');
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const assert = require('assert/strict');
const delay = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  assert.equal(fs.existsSync(process.argv[3]), false);
  const net = require('net');
  await new Promise((resolve, reject) => {
    const s = net.connect({host:'127.0.0.1', port:Number(process.argv[2])});
    s.setTimeout(1500);
    s.once('connect', () => { s.destroy(); reject(Error('host loopback exposed')); });
    s.once('timeout', () => { s.destroy(); reject(Error('host loopback check timed out')); });
    s.once('error', err => err.code === 'ECONNREFUSED' ? resolve() : reject(err));
  });
  const server = http.createServer((req, res) => {
    if (req.url === '/login') { res.setHeader('Set-Cookie', 'fixture=synthetic; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600'); res.end('ok'); return; }
    if (req.url === '/check') { res.end(req.headers.cookie === 'fixture=synthetic' ? 'yes' : 'no'); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end('<button id="login">Synthetic consent</button><script>login.onclick=async e=>{if(!e.isTrusted)return;await fetch("/login");localStorage.setItem("fixture","synthetic");document.title="done"}</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const x = spawn('/usr/bin/Xvnc', [':93','-rfbport','-1','-rfbunixpath','/tmp/rfb.sock','-rfbunixmode','0600','-SecurityTypes','None','-nolisten','tcp','-geometry','1024x768','-depth','24'], {stdio:'ignore'});
  let context;
  try {
    for (let i=0; i<100 && !fs.existsSync('/tmp/.X11-unix/X93'); i++) { if (x.exitCode !== null) throw Error('Xvnc exited'); await delay(50); }
    assert(fs.existsSync('/tmp/.X11-unix/X93'));
    const options={executablePath:'/chrome/chrome',headless:false,env:{...process.env,DISPLAY:':93'},args:['--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--disable-background-networking']};
    context = await chromium.launchPersistentContext('/tmp/profile', options);
    let page = context.pages()[0] || await context.newPage();
    await page.goto(url); await page.locator('#login').click(); await page.waitForFunction(() => document.title === 'done');
    assert.equal(await page.evaluate(async () => (await fetch('/check')).text()), 'yes');
    await context.close(); context = null;
    context = await chromium.launchPersistentContext('/tmp/profile', options);
    page = context.pages()[0] || await context.newPage(); await page.goto(url);
    assert.equal(await page.evaluate(async () => (await fetch('/check')).text()), 'yes');
    assert.equal(await page.evaluate(() => localStorage.getItem('fixture')), 'synthetic');
    console.log('PASS synthetic headed persistent profile: trusted click, HttpOnly cookie and localStorage restored after browser restart');
  } finally {
    if (context) await context.close();
    x.kill('SIGTERM'); await new Promise(resolve => { if (x.exitCode !== null) resolve(); else x.once('exit', resolve); });
    await new Promise(resolve => server.close(resolve));
  }
})().catch(err => { console.error(err.stack); process.exitCode=1; });
