import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDevChannel, callAunt } from '../src/dev-channel.js';
import { startProactive, stopProactive } from '../src/proactive.js';

async function fixture(handler, fn, timeoutMs = 5000) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'aunt-test-'));
  let calls = 0;
  const server = http.createServer((req, res) => { calls++; handler(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  initDevChannel({ dataDir: dir, hermesUrl: `http://127.0.0.1:${server.address().port}/message`, timeoutMs });
  try { await fn(() => calls); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('HTTP failure with error message is not a successful aunt reply', async () => {
  await fixture((req, res) => { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ message: 'service unavailable' })); }, async calls => {
    const result = await callAunt({ message: 'synthetic' });
    assert.equal(result.status, 'error');
    assert.ok(!result.reply);
    assert.equal(calls(), 1);
  });
});

test('empty and application-error responses do not imply delivery', async () => {
  for (const body of ['{}', '{"status":"error","message":"no"}', 'not json']) {
    await fixture((req, res) => { res.writeHead(200); res.end(body); }, async calls => {
      const result = await callAunt({ message: 'synthetic' });
      assert.equal(result.status, 'error');
      assert.equal(result.outcome, 'unknown');
      assert.ok(!result.reply);
      assert.equal(calls(), 1);
    });
  }
});

test('redirect cannot cause an automatic second POST', async () => {
  await fixture((req, res) => { res.writeHead(307, { location: '/again' }); res.end(); }, async calls => {
    const result = await callAunt({ message: 'synthetic' });
    assert.equal(result.status, 'error');
    assert.equal(calls(), 1);
  });
});

test('connection reset is unknown and not retried', async () => {
  await fixture(req => req.socket.destroy(), async calls => {
    const result = await callAunt({ message: 'synthetic' });
    assert.equal(result.status, 'error');
    assert.equal(result.outcome, 'unknown');
    assert.ok(!result.reply);
    assert.equal(calls(), 1);
  });
});

test('timeout is unknown and sends once', async () => {
  await fixture(() => {}, async calls => {
    const result = await callAunt({ message: 'synthetic' });
    assert.equal(result.status, 'error');
    assert.equal(result.outcome, 'unknown');
    assert.ok(!result.reply);
    assert.equal(calls(), 1);
  }, 500);
});

test('successful exchange preserves sender identity and original message', async () => {
  let payload;
  await fixture((req, res) => {
    let data = ''; req.on('data', chunk => data += chunk);
    req.on('end', () => { payload = JSON.parse(data); res.writeHead(200); res.end('{"reply":"synthetic reply"}'); });
  }, async calls => {
    const result = await callAunt({ message: 'synthetic' });
    assert.equal(result.status, 'ok');
    assert.equal(result.reply, 'synthetic reply');
    assert.equal(payload.sender_id, 'xiaoyu');
    assert.equal(payload.sender_display_name, '小肥鱼');
    assert.equal(payload.message, 'synthetic');
    assert.equal(calls(), 1);
  });
});

test('proactive shutdown reports unconfirmed aunt request and does not log diary or retry', async () => {
  let received;
  const started = new Promise(resolve => received = resolve);
  const diary = [];
  await fixture(() => received(), async calls => {
    startProactive({ ownerId: 'synthetic', activeStart: 0, activeEnd: 0, initialDelayMs: 0,
      brain: { reply: async () => ({ text: JSON.stringify({ want: true, target: 'aunt', text: 'synthetic' }) }) },
      memory: { sessionTurns: () => [], logDiary: entry => diary.push(entry) }, bot: { send: () => assert.fail('wrong recipient') } });
    await started;
    await assert.rejects(stopProactive({ timeoutMs: 5000 }), /未知/);
    assert.equal(calls(), 1);
    assert.deepEqual(diary, []);
  }, 1000);
});
