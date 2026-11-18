import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startVirtualRoomServer } from '../src/virtual-room.js';

test('贴吧入口只打开百度官方登录页，不接入小鱼账号', async () => {
  const dir = fs.mkdtempSync(path.join('/root/.hermes/cache/scratch/', 'tieba-login-test-'));
  const room = startVirtualRoomServer({port:0, host:'127.0.0.1', dataDir:dir});
  try {
    const addr = await room.ready;
    const base = `http://127.0.0.1:${addr.port}`;
    const response = await fetch(base + '/login');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    const html = await response.text();
    assert.match(html, /<h2>百度贴吧<\/h2>/);
    assert.match(html, /小鱼.*未接入/);
    assert.match(html, /不会.*(?:同步|保存).*登录/);
    const link = html.match(/<a\b[^>]*href="https:\/\/passport\.baidu\.com\/"[^>]*>/);
    assert.ok(link, 'direct official HTTPS login link');
    assert.match(link[0], /target="_blank"/);
    assert.match(link[0], /rel="noopener noreferrer"/);
    assert.match(html, /id="bili-start"/);
    assert.match(html, /id="douyin-start"/);
    for (const action of ['status', 'start', 'poll', 'qr']) {
      const r = await fetch(`${base}/api/account/tieba/${action}`, { method: action === 'start' ? 'POST' : 'GET', headers: {origin: base, 'content-type': 'application/json'} });
      assert.equal(r.status, 404);
    }
  } finally {
    await room.stop();
    fs.rmSync(dir, {recursive:true, force:true});
  }
});
