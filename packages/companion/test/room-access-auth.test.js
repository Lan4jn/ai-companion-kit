import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startVirtualRoomServer } from '../src/virtual-room.js';

const token = 'test-only-0123456789-0123456789-abc';
test('opt-in authentication protects every route including login and streaming', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'room-auth-'));
  const room = startVirtualRoomServer({ port: 0, host: '127.0.0.1', dataDir: dir, accessToken: token });
  try {
    const { port } = await room.ready;
    const base = `http://127.0.0.1:${port}`;
    for (const endpoint of ['/', '/panel', '/api/status', '/events', '/login', '/api/account/bili/status', '/dev/chat']) {
      const unauth = await fetch(base + endpoint);
      assert.equal(unauth.status, 401, endpoint);
      assert.match(unauth.headers.get('www-authenticate'), /^Basic /);
      assert.equal(unauth.headers.get('cache-control'), 'no-store');
      assert.equal((await fetch(base + endpoint, { headers: { authorization: 'Basic ' + Buffer.from('room:wrong').toString('base64') } })).status, 401, endpoint);
    }
    const headers = { authorization: 'Basic ' + Buffer.from('room:' + token).toString('base64') };
    for (const endpoint of ['/', '/panel', '/api/status', '/login']) assert.equal((await fetch(base + endpoint, { headers })).status, 200, endpoint);
    assert.equal((await fetch(base + '/api/status', { headers: { ...headers, origin: 'http://evil.test' } })).status, 403);
  } finally { await room.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('direct LAN interface enforces the same credentials', async (t) => {
  const ip = Object.values(os.networkInterfaces()).flat().find(i => i.family === 'IPv4' && i.address.startsWith('192.168.31.') && i.netmask === '255.255.255.0')?.address;
  if (!ip) return t.skip('approved LAN interface unavailable');
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'room-auth-lan-'));
  const room = startVirtualRoomServer({ port: 0, host: ip, dataDir: dir, accessToken: token });
  try {
    const {port} = await room.ready;
    const base = `http://${ip}:${port}`;
    assert.equal((await fetch(base + '/login')).status, 401);
    const authorization = 'Basic ' + Buffer.from('room:' + token).toString('base64');
    assert.equal((await fetch(base + '/login', {headers:{authorization}})).status, 200);
    assert.equal((await fetch(base + '/panel', {headers:{authorization}})).status, 200);
  } finally { await room.stop(); fs.rmSync(dir, {recursive:true, force:true}); }
});

test('authenticated static assets and event streams are not cacheable', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'room-auth-cache-'));
  const room = startVirtualRoomServer({ port: 0, host: '127.0.0.1', dataDir: dir, accessToken: token });
  try {
    const { port } = await room.ready;
    const headers = { authorization: 'Basic ' + Buffer.from('room:' + token).toString('base64') };
    for (const endpoint of ['/room_assets/sample-room.png', '/events']) {
      const res = await fetch(`http://127.0.0.1:${port}${endpoint}`, { headers });
      assert.equal(res.status, 200, endpoint);
      assert.match(res.headers.get('cache-control'), /no-store/, endpoint);
      await res.body?.cancel();
    }
  } finally { await room.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Basic scheme accepts case-insensitive scheme names', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'room-auth-scheme-'));
  const room = startVirtualRoomServer({ port: 0, host: '127.0.0.1', dataDir: dir, accessToken: token });
  try {
    const { port } = await room.ready;
    const authorization = 'basic ' + Buffer.from('room:' + token).toString('base64');
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { authorization } })).status, 200);
  } finally { await room.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('rejects weak or malformed configured token', () => {
  for (const accessToken of ['', 'short', 'x'.repeat(31), 'x'.repeat(32) + '\n']) {
    assert.throws(() => startVirtualRoomServer({ port: 0, accessToken }), /accessToken/);
  }
});
