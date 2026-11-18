import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { OneBot } from '../src/transport-onebot.js';

test('a stalled WebSocket handshake times out and retries', { timeout: 26000 }, async () => {
  const sockets = new Set();
  let attempts = 0;
  const server = http.createServer();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', () => { attempts++; }); // deliberately never respond
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const bot = new OneBot({ wsUrl: `ws://127.0.0.1:${server.address().port}`, httpUrl: '' });
  try {
    const deadline = Date.now() + 22000;
    while (attempts < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(attempts >= 2, `expected a second handshake after timeout; got ${attempts}`);
  } finally {
    bot.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});
