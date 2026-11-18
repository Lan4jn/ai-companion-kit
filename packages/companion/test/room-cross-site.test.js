import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { startVirtualRoomServer } from '../src/virtual-room.js';

test('room blocks cross-site requests before route handling', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/root/.hermes/cache/scratch', 'room-origin-'));
  const room = startVirtualRoomServer({ port: 0, host: '127.0.0.1', dataDir: dir });
  try {
    const { port } = await room.ready;
    const base = `http://127.0.0.1:${port}`;
    for (const [endpoint, options] of [
      ['/api/status', { headers: { origin: 'http://evil.test' } }],
      ['/api/diary/list', { headers: { 'sec-fetch-site': 'cross-site' } }],
      ['/api/diary/generate', { method: 'POST', headers: { origin: 'http://evil.test' } }],
      ['/api/aunt/chat', { headers: { 'sec-fetch-site': 'same-site' } }],
      ['/events', { headers: { 'sec-fetch-site': 'cross-site' } }],
      ['/panel', { headers: { origin: 'null' } }],
      ['/api/status', { headers: { origin: base.replace('http:', 'https:') } }],
    ]) assert.equal((await fetch(base + endpoint, options)).status, 403, endpoint);
    const rebinding = await new Promise((resolve, reject) => http.get(base + '/api/status', { headers: { host: `evil.test:${port}` } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject));
    assert.equal(rebinding, 403);
    assert.equal((await fetch(base + '/api/status', { headers: { origin: base, 'sec-fetch-site': 'same-origin' } })).status, 200);
    for (const endpoint of ['/api/aunt/chat', '/api/diary/list', '/diary', '/']) {
      const response = await fetch(base + endpoint, { headers: { 'sec-fetch-site': 'same-origin' } });
      assert.equal(response.status, 200, endpoint);
      assert.equal(response.headers.get('x-frame-options'), 'DENY');
      await response.arrayBuffer();
    }
    const stream = await fetch(base + '/events', { headers: { 'sec-fetch-site': 'same-origin' } });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get('content-type'), /text\/event-stream/);
    const reader = stream.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /data:/);
    await reader.cancel();
  } finally {
    await room.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
