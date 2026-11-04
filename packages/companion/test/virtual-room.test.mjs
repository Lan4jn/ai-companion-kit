import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '..');
const virtualRoomModuleHref = pathToFileURL(path.join(packageRoot, 'src/virtual-room.js')).href;

// Helper to make HTTP request to test server
function request(port, options = {}) {
  return new Promise((resolve, reject) => {
    const { method = 'GET', pathname = '/', headers = {}, body = null } = options;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: raw.toString('utf8'),
            raw,
          });
        });
      }
    );
    req.on('error', reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

test('TDD: virtual-room imports cleanly without playwright-core dependency', async () => {
  const mod = await import(virtualRoomModuleHref);
  assert.ok(typeof mod.startVirtualRoomServer === 'function', 'startVirtualRoomServer should be exported');
  assert.ok(typeof mod.setRoomState === 'function', 'setRoomState should be exported');
  assert.ok(typeof mod.getRoomState === 'function', 'getRoomState should be exported');
});

test('TDD: server lifecycle, ready promise, loopback default and clean stop', async () => {
  const { startVirtualRoomServer } = await import(virtualRoomModuleHref);
  const room = startVirtualRoomServer({
    port: 0,
    host: '127.0.0.1',
    transitionMs: 50,
  });

  assert.ok(room.ready, 'room should expose ready Promise or property');
  await room.ready;
  const address = room.server.address();
  assert.ok(address.port > 0, 'server should bind to an ephemeral port');
  assert.equal(address.address, '127.0.0.1', 'server should default to loopback 127.0.0.1');

  // Verify getState returns a copy
  const state1 = room.getState();
  state1.state = 'corrupted_state';
  assert.notEqual(room.getState().state, 'corrupted_state', 'getState must return a copy');

  // Verify stop closes cleanly and repeated stop does not throw
  await room.stop();
  await assert.doesNotReject(async () => {
    await room.stop();
  }, 'repeated stop must not throw');
});

test('TDD: HTML includes character.css, renderer.js module, HUD action buttons and room:state event', async () => {
  const { startVirtualRoomServer } = await import(virtualRoomModuleHref);
  const room = startVirtualRoomServer({ port: 0, host: '127.0.0.1' });
  await room.ready;
  const port = room.server.address().port;

  try {
    const res = await request(port, { pathname: '/' });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/html/);

    // Contract: character.css and renderer.js module with version query param to prevent browser caching stale code
    assert.match(res.body, /\/room_assets\/character\/character\.css\?v=[a-zA-Z0-9_-]+/, 'HTML must link character.css with ?v= query param');
    assert.match(res.body, /src="\/room_assets\/character\/renderer\.js\?v=[a-zA-Z0-9_-]+"/, 'HTML must import renderer.js as module with ?v= query param');

    // Contract: window CustomEvent room:state dispatch
    assert.ok(res.body.includes("CustomEvent('room:state'"), 'HTML must dispatch room:state CustomEvent in applyRoomState');

    // Contract: independent "去书桌" button
    assert.ok(res.body.includes("triggerAction('desk')"), 'HTML must include triggerAction("desk") button');

    // Fix: Double filter removed, only .base kept
    assert.ok(!res.body.includes('#stage image, #stage .base'), 'Double filter selector #stage image, #stage .base must be fixed to only #stage .base');
    assert.ok(res.body.includes('#stage .base'), 'CSS must keep #stage .base filter');
  } finally {
    await room.stop();
  }
});

test('TDD: Static assets nested paths, MIME types, directory traversal and hidden file blocking', async () => {
  const tmpAssets = fs.mkdtempSync(path.join(os.tmpdir(), 'room-assets-test-'));
  const charDir = path.join(tmpAssets, 'character');
  fs.mkdirSync(charDir, { recursive: true });

  fs.writeFileSync(path.join(charDir, 'manifest.json'), JSON.stringify({ id: 'test' }));
  fs.writeFileSync(path.join(charDir, 'renderer.js'), 'export default {};');
  fs.writeFileSync(path.join(charDir, 'character.css'), '.char { display: block; }');
  fs.writeFileSync(path.join(tmpAssets, '.hidden.txt'), 'secret');

  const { startVirtualRoomServer } = await import(virtualRoomModuleHref);
  const room = startVirtualRoomServer({
    port: 0,
    host: '127.0.0.1',
    assetsDir: tmpAssets,
  });
  await room.ready;
  const port = room.server.address().port;

  try {
    // 1. JSON MIME & no-cache
    const jsonRes = await request(port, { pathname: '/room_assets/character/manifest.json' });
    assert.equal(jsonRes.statusCode, 200);
    assert.match(jsonRes.headers['content-type'], /application\/json/);
    assert.match(jsonRes.headers['cache-control'], /no-cache|no-store/, 'JSON asset must have no-cache cache-control');

    // 2. JS MIME & no-cache
    const jsRes = await request(port, { pathname: '/room_assets/character/renderer.js' });
    assert.equal(jsRes.statusCode, 200);
    assert.match(jsRes.headers['content-type'], /javascript/);
    assert.match(jsRes.headers['cache-control'], /no-cache|no-store/, 'JS asset must have no-cache cache-control');

    // 3. CSS MIME & no-cache
    const cssRes = await request(port, { pathname: '/room_assets/character/character.css' });
    assert.equal(cssRes.statusCode, 200);
    assert.match(cssRes.headers['content-type'], /text\/css/);
    assert.match(cssRes.headers['cache-control'], /no-cache|no-store/, 'CSS asset must have no-cache cache-control');

    // 4. Directory access blocked
    const dirRes = await request(port, { pathname: '/room_assets/character/' });
    assert.ok(dirRes.statusCode === 403 || dirRes.statusCode === 404, 'Directory access should be 403 or 404');

    // 5. Path traversal blocked
    const traversalRes = await request(port, { pathname: '/room_assets/../package.json' });
    assert.ok(traversalRes.statusCode === 403 || traversalRes.statusCode === 404, 'Path traversal must be rejected');

    // 6. Hidden file blocked
    const hiddenRes = await request(port, { pathname: '/room_assets/.hidden.txt' });
    assert.ok(hiddenRes.statusCode === 403 || hiddenRes.statusCode === 404, 'Hidden files must be rejected');
  } finally {
    await room.stop();
    fs.rmSync(tmpAssets, { recursive: true, force: true });
  }
});

test('TDD: Video HEAD request and Range 206 / 416 support', async () => {
  const tmpAssets = fs.mkdtempSync(path.join(os.tmpdir(), 'room-range-test-'));
  const clipsDir = path.join(tmpAssets, 'character', 'clips');
  fs.mkdirSync(clipsDir, { recursive: true });

  const dummyVideo = Buffer.alloc(1000, 0x42);
  fs.writeFileSync(path.join(clipsDir, 'idle.webm'), dummyVideo);

  const { startVirtualRoomServer } = await import(virtualRoomModuleHref);
  const room = startVirtualRoomServer({
    port: 0,
    host: '127.0.0.1',
    assetsDir: tmpAssets,
  });
  await room.ready;
  const port = room.server.address().port;

  try {
    // 1. HEAD request
    const headRes = await request(port, {
      method: 'HEAD',
      pathname: '/room_assets/character/clips/idle.webm',
    });
    assert.equal(headRes.statusCode, 200);
    assert.equal(headRes.headers['content-length'], '1000');
    assert.equal(headRes.headers['accept-ranges'], 'bytes');
    assert.equal(headRes.headers['content-type'], 'video/webm');
    assert.equal(headRes.raw.length, 0, 'HEAD must have no body');

    // 2. Range request: first 100 bytes (0-99)
    const rangeRes = await request(port, {
      method: 'GET',
      pathname: '/room_assets/character/clips/idle.webm',
      headers: { Range: 'bytes=0-99' },
    });
    assert.equal(rangeRes.statusCode, 206);
    assert.equal(rangeRes.headers['content-range'], 'bytes 0-99/1000');
    assert.equal(rangeRes.headers['content-length'], '100');
    assert.equal(rangeRes.raw.length, 100);

    // 3. Suffix range request: last 50 bytes
    const suffixRes = await request(port, {
      method: 'GET',
      pathname: '/room_assets/character/clips/idle.webm',
      headers: { Range: 'bytes=-50' },
    });
    assert.equal(suffixRes.statusCode, 206);
    assert.equal(suffixRes.headers['content-range'], 'bytes 950-999/1000');
    assert.equal(suffixRes.headers['content-length'], '50');

    // 4. Invalid range request
    const invalidRes = await request(port, {
      method: 'GET',
      pathname: '/room_assets/character/clips/idle.webm',
      headers: { Range: 'bytes=2000-3000' },
    });
    assert.equal(invalidRes.statusCode, 416);
    assert.equal(invalidRes.headers['content-range'], 'bytes */1000');
  } finally {
    await room.stop();
    fs.rmSync(tmpAssets, { recursive: true, force: true });
  }
});

test('TDD: Custom dataDir reads diary without hardcoded /root', async () => {
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'room-data-test-'));
  const diaryFile = path.join(tmpData, 'diary.jsonl');
  fs.writeFileSync(
    diaryFile,
    JSON.stringify({ t: Date.now(), title: '测试摸鱼', thought: '今天成功通过TDD测试' }) + '\n'
  );

  const { startVirtualRoomServer } = await import(virtualRoomModuleHref);
  const room = startVirtualRoomServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: tmpData,
  });
  await room.ready;
  const port = room.server.address().port;

  try {
    const res = await request(port, { pathname: '/api/room/inspect?slot=shelf' });
    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.ok(data.lines.some(([k, v]) => k.includes('测试摸鱼') && v.includes('今天成功通过TDD测试')));
  } finally {
    await room.stop();
    fs.rmSync(tmpData, { recursive: true, force: true });
  }
});

test('TDD: Desk inspect uses isLive and calls injected getDouyinStatus provider', async () => {
  const { startVirtualRoomServer } = await import(virtualRoomModuleHref);
  let providerCalled = false;
  const room = startVirtualRoomServer({
    port: 0,
    host: '127.0.0.1',
    getDouyinStatus: () => {
      providerCalled = true;
      return {
        lastVideo: { title: '自定义抖音视频测试' },
        summary: '小鱼正在看测试视频',
      };
    },
  });
  await room.ready;
  const port = room.server.address().port;

  try {
    const res = await request(port, { pathname: '/api/room/inspect?slot=desk' });
    assert.equal(res.statusCode, 200);
    assert.equal(providerCalled, true, 'getDouyinStatus provider must be called');
    const data = JSON.parse(res.body);
    assert.ok(data.lines.some(([k, v]) => v.includes('自定义抖音视频测试')));
  } finally {
    await room.stop();
  }
});

test('TDD: Action API validation, body limit, Origin check, and 503 when platform not injected', async () => {
  const { startVirtualRoomServer } = await import(virtualRoomModuleHref);
  const room = startVirtualRoomServer({ port: 0, host: '127.0.0.1' });
  await room.ready;
  const port = room.server.address().port;

  try {
    // 1. Unknown action -> 400
    const invalidActRes = await request(port, {
      method: 'POST',
      pathname: '/api/action',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'unauthorized_action' }),
    });
    assert.equal(invalidActRes.statusCode, 400);

    // 2. Cross-origin request rejection -> 403
    const crossOriginRes = await request(port, {
      method: 'POST',
      pathname: '/api/action',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://malicious-attacker.com',
      },
      body: JSON.stringify({ action: 'bed' }),
    });
    assert.equal(crossOriginRes.statusCode, 403);

    // 3. Platform not injected -> 503 (not fabricated 200)
    const douyinNoPlatformRes = await request(port, {
      method: 'POST',
      pathname: '/api/action',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'douyin' }),
    });
    assert.equal(douyinNoPlatformRes.statusCode, 503);

    // 4. Valid action -> 200
    const sitRes = await request(port, {
      method: 'POST',
      pathname: '/api/action',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'sit' }),
    });
    assert.equal(sitRes.statusCode, 200);
    assert.equal(room.getState().state, 'bed_sit');
  } finally {
    await room.stop();
  }
});

test('TDD: Transition generation cancels older crawl timers when new state arrives', async () => {
  const { startVirtualRoomServer } = await import(virtualRoomModuleHref);
  const room = startVirtualRoomServer({
    port: 0,
    host: '127.0.0.1',
    transitionMs: 100,
  });
  await room.ready;

  try {
    // Ensure starting in bed
    room.setState('bed_phone');
    assert.equal(room.getState().state, 'bed_phone');

    // Trigger crawl to desk
    room.setState('desk_laptop');
    assert.equal(room.getState().state, 'crawling');

    // While crawling, user switches to sleep before 100ms expires
    await new Promise((r) => setTimeout(r, 20));
    room.setState('bed_sleep');
    assert.equal(room.getState().state, 'bed_sleep');

    // Wait until after 100ms: old crawling timer must NOT overwrite bed_sleep!
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(room.getState().state, 'bed_sleep', 'Old transition timer must not overwrite new state');
  } finally {
    await room.stop();
  }
});

test('TDD: metadata update setState(null, { message }) during crawling preserves transition and message', async () => {
  const { startVirtualRoomServer } = await import(virtualRoomModuleHref);
  const room = startVirtualRoomServer({
    port: 0,
    host: '127.0.0.1',
    transitionMs: 80,
  });
  await room.ready;

  try {
    room.setState('bed_phone');
    assert.equal(room.getState().state, 'bed_phone');

    // 1. Trigger crawl to desk
    room.setState('desk_laptop');
    assert.equal(room.getState().state, 'crawling');

    // 2. Chat message arrives during crawling: setState(null, { message: '新聊天回复' })
    await new Promise((r) => setTimeout(r, 20));
    room.setState(null, { message: '新聊天回复', recentInput: 'chat' });
    assert.equal(room.getState().state, 'crawling', 'Should still be crawling');
    assert.equal(room.getState().message, '新聊天回复', 'Message should be updated immediately');

    // 3. Wait for crawl transition to complete (> 80ms)
    await new Promise((r) => setTimeout(r, 90));

    // Must reach desk_laptop, NOT get stuck in crawling!
    assert.equal(room.getState().state, 'desk_laptop', 'Must successfully transition to desk_laptop');
    // Must NOT overwrite the chat message that arrived during transition!
    assert.equal(room.getState().message, '新聊天回复', 'Must preserve the message updated during crawling');
  } finally {
    await room.stop();
  }
});

test('TDD: state includes monotonic version number on every state and metadata update', async () => {
  const { startVirtualRoomServer } = await import(virtualRoomModuleHref);
  const room = startVirtualRoomServer({
    port: 0,
    host: '127.0.0.1',
    transitionMs: 50,
  });
  await room.ready;

  try {
    const s0 = room.getState();
    assert.ok(typeof s0.version === 'number' && s0.version >= 1, 'Initial state must have integer version');
    const v0 = s0.version;

    // Update metadata -> version increments
    room.setState(null, { message: 'v-test' });
    const s1 = room.getState();
    assert.equal(s1.version, v0 + 1, 'Version must increment on metadata update');

    // Change state to desk -> version increments when entering crawling
    room.setState('desk_laptop');
    const s2 = room.getState();
    assert.equal(s2.state, 'crawling');
    assert.equal(s2.version, v0 + 2, 'Version must increment when entering crawling');

    // Transition completes -> version increments when reaching desk_laptop
    await new Promise((r) => setTimeout(r, 70));
    const s3 = room.getState();
    assert.equal(s3.state, 'desk_laptop');
    assert.equal(s3.version, v0 + 3, 'Version must increment when transition completes');
  } finally {
    await room.stop();
  }
});

test('TDD: SSE broadcast and clean shutdown without socket leakage', async () => {
  const { startVirtualRoomServer } = await import(virtualRoomModuleHref);
  const room = startVirtualRoomServer({ port: 0, host: '127.0.0.1' });
  await room.ready;
  const port = room.server.address().port;

  const sseEvents = [];
  let sseEnded = false;

  const sseReq = http.request(
    {
      hostname: '127.0.0.1',
      port,
      path: '/events',
      headers: { Accept: 'text/event-stream' },
    },
    (res) => {
      res.on('data', (chunk) => {
        sseEvents.push(chunk.toString('utf8'));
      });
      res.on('end', () => {
        sseEnded = true;
      });
    }
  );
  sseReq.end();

  // Wait for initial SSE connection event
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(sseEvents.length >= 1, 'SSE client should receive initial state snapshot');

  // Broadcast state change
  room.setState('bed_sit', { action: '测试发呆' });
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(sseEvents.some((e) => e.includes('bed_sit')), 'SSE client should receive updated state');

  // Stop server and verify SSE connection ends
  await room.stop();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sseEnded, true, 'SSE response must be closed on server.stop()');
});

test('TDD: Malformed URI and invalid Host headers return 400 safely without throwing', async () => {
  const { startVirtualRoomServer } = await import(virtualRoomModuleHref);
  const room = startVirtualRoomServer({ port: 0, host: '127.0.0.1' });
  await room.ready;
  const port = room.server.address().port;

  try {
    // 1. Malformed URI decode: %ZZ
    const malformedRes = await request(port, { pathname: '/room_assets/%ZZ' });
    assert.equal(malformedRes.statusCode, 400, 'Malformed percent-encoding must return 400');

    // 2. Malformed Host header that breaks new URL
    const badHostRes = await request(port, {
      pathname: '/',
      headers: { Host: '[invalid-host-bracket' },
    });
    assert.equal(badHostRes.statusCode, 400, 'Invalid Host header must return 400');
  } finally {
    await room.stop();
  }
});

test('TDD: Symlink escape check via realpath rejects files pointing outside assetsRoot', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-symlink-test-'));
  const assetsDir = path.join(tmpDir, 'assets');
  const secretDir = path.join(tmpDir, 'secret');
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.mkdirSync(secretDir, { recursive: true });

  const secretFile = path.join(secretDir, 'secret.json');
  fs.writeFileSync(secretFile, JSON.stringify({ secret: 'password123' }));

  const symlinkPath = path.join(assetsDir, 'escape');
  let canSymlink = true;
  try {
    const isWin = process.platform === 'win32';
    fs.symlinkSync(secretDir, symlinkPath, isWin ? 'junction' : 'dir');
  } catch (err) {
    canSymlink = false;
    t.skip(`Skipping symlink test due to OS privilege restriction: ${err.message}`);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return;
  }

  const { startVirtualRoomServer } = await import(virtualRoomModuleHref);
  const room = startVirtualRoomServer({
    port: 0,
    host: '127.0.0.1',
    assetsDir,
  });
  await room.ready;
  const port = room.server.address().port;

  try {
    const res = await request(port, { pathname: '/room_assets/escape/secret.json' });
    assert.equal(res.statusCode, 403, 'Symlink pointing outside assets directory must return 403');
  } finally {
    await room.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TDD: Range bytes=0-999999 clamps end to size-1 with 206, unsafe integers return 416', async () => {
  const tmpAssets = fs.mkdtempSync(path.join(os.tmpdir(), 'room-range-clamp-test-'));
  const clipsDir = path.join(tmpAssets, 'character', 'clips');
  fs.mkdirSync(clipsDir, { recursive: true });

  const dummyVideo = Buffer.alloc(1000, 0x5a); // 1000 bytes
  fs.writeFileSync(path.join(clipsDir, 'clamp.webm'), dummyVideo);

  const { startVirtualRoomServer } = await import(virtualRoomModuleHref);
  const room = startVirtualRoomServer({
    port: 0,
    host: '127.0.0.1',
    assetsDir: tmpAssets,
  });
  await room.ready;
  const port = room.server.address().port;

  try {
    // 1. Oversized end range: bytes=0-999999 on 1000 byte file must clamp to size-1 (999) and return 206
    const clampRes = await request(port, {
      method: 'GET',
      pathname: '/room_assets/character/clips/clamp.webm',
      headers: { Range: 'bytes=0-999999' },
    });
    assert.equal(clampRes.statusCode, 206, 'Oversized end range should clamp and return 206');
    assert.equal(clampRes.headers['content-range'], 'bytes 0-999/1000');
    assert.equal(clampRes.headers['content-length'], '1000');
    assert.equal(clampRes.raw.length, 1000);

    // 2. Unsafe integer range: exceeds safe integer bounds
    const unsafeIntRes = await request(port, {
      method: 'GET',
      pathname: '/room_assets/character/clips/clamp.webm',
      headers: { Range: 'bytes=0-999999999999999999999999999' },
    });
    assert.equal(unsafeIntRes.statusCode, 416, 'Unsafe integer in range header must return 416');

    // 3. Start >= size returns 416
    const startOutOfBoundsRes = await request(port, {
      method: 'GET',
      pathname: '/room_assets/character/clips/clamp.webm',
      headers: { Range: 'bytes=1000-2000' },
    });
    assert.equal(startOutOfBoundsRes.statusCode, 416, 'start >= size must return 416');
  } finally {
    await room.stop();
    fs.rmSync(tmpAssets, { recursive: true, force: true });
  }
});

test('TDD: examples/room-demo.js starts server with --port and loopback', async () => {
  const demoPath = path.join(packageRoot, 'examples/room-demo.js');
  assert.ok(fs.existsSync(demoPath), 'examples/room-demo.js must exist');
  const content = fs.readFileSync(demoPath, 'utf8');
  assert.ok(content.includes('--port') || content.includes('18889'), 'room-demo.js should support --port 18889');
  assert.ok(!content.includes('playwright'), 'room-demo.js must not load playwright');
});
