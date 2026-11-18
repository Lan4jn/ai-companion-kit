import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startVirtualRoomServer } from '../src/virtual-room.js';

test('legacy Douyin HTTP login is unavailable without spawning a daemon', { skip: process.env.SYNTHETIC_LEGACY_ROUTE_TEST !== '1' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-route-'));
  const marker = process.env.SYNTHETIC_DAEMON_MARKER;
  assert.ok(marker && path.dirname(marker) === os.tmpdir());
  const room = startVirtualRoomServer({port:0, host:'127.0.0.1', dataDir:dir});
  try {
    const address = await room.ready;
    const base = `http://127.0.0.1:${address.port}`;
    const response = await fetch(base+'/api/account/douyin/start', {method:'POST', headers:{origin:base}});
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {state:'disabled'});
    assert.match(response.headers.get('cache-control'), /no-store/);
    const html = await fetch(base+'/login').then(r=>r.text());
    assert.match(html, /id="douyin-start"[^>]*disabled/);
    assert.match(html, /抖音扫码登录暂不可用/);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(fs.existsSync(marker), false);
    assert.equal((await fetch(base+'/api/account/douyin/status').then(r=>r.json())).state, 'offline');
    assert.equal((await fetch(base+'/api/account/bili/status').then(r=>r.json())).state, 'offline');
    assert.equal((await fetch(base+'/api/account/douyin/poll').then(r=>r.json())).state, 'expired');
    assert.equal((await fetch(base+'/api/account/douyin/qr')).status, 404);
    for (const [method, route] of [['GET','/qrcode'], ['POST','/api/douyin/refresh'], ['POST','/api/douyin/sms'], ['GET','/api/douyin/qr.png'], ['GET','/api/douyin/status'], ['GET','/room_assets/douyin_qr_live.png']]) {
      assert.equal((await fetch(base+route, {method, headers:{origin:base}})).status, 404, route);
    }
    assert.equal(fs.existsSync(marker), false);
    assert.equal((await fetch(base+'/api/account/douyin/start',{method:'POST',headers:{origin:'http://evil.test'}})).status, 403);
  } finally {
    await room.stop();
    fs.rmSync(dir, {recursive:true, force:true});
    fs.rmSync(marker, {force:true});
  }
});
