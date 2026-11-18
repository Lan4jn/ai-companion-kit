import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { setupProductionFanqie } from '../src/index.js';
import { OneBot } from '../src/transport-onebot.js';

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`real ${signal} exits fake service cleanly after draining`, async () => {
    const source = `import {setupProductionFanqie} from ${JSON.stringify(new URL('../src/index.js', import.meta.url).href)};
      setupProductionFanqie({cfg:{}, start:()=>({stop:()=>new Promise(r=>setTimeout(r,40))})});
      console.log('READY'); setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, sig) => resolve({code, sig})); });
    try {
      await Promise.race([new Promise(resolve => child.stdout.on('data', chunk => { output += chunk; if (output.includes('READY')) resolve(); })),
        new Promise((_, reject) => setTimeout(() => reject(new Error('child did not start')), 5000))]);
      child.kill(signal); child.kill(signal);
      assert.deepEqual(await exited, { code: 0, sig: null });
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  });
}

test('shutdown cancels an actual scheduled websocket reconnect', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  let connections = 0;
  server.on('connection', socket => { connections++; socket.close(); });
  const bot = new OneBot({ wsUrl: `ws://127.0.0.1:${server.address().port}`, dataDir: process.env.TMPDIR });
  try {
    for (let i = 0; i < 100 && !bot.reconnectTimer; i++) await new Promise(r => setTimeout(r, 10));
    assert.ok(bot.reconnectTimer);
    bot.stopReceiving(); bot.close();
    await new Promise(r => setTimeout(r, 5100));
    assert.equal(connections, 1); assert.equal(bot.reconnectTimer, null);
  } finally { bot.close(); await new Promise(r => server.close(r)); }
});

test('transport shutdown stops reconnect and drains active send', async () => {
  let release; const original = globalThis.fetch;
  globalThis.fetch = () => new Promise(resolve => { release = resolve; });
  const bot = new OneBot({ wsUrl: 'ws://127.0.0.1:1', httpUrl: 'http://unused', dataDir: process.env.TMPDIR });
  try {
    const sending = bot.send('group:42', 'fixture');
    bot.stopReceiving();
    let done = false; const draining = bot.drain().then(() => { done = true; });
    await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(done, false);
    release({ok:true, text: async () => '{"status":"ok","retcode":0}'});
    assert.equal((await sending).ok, true); await draining;
    await bot.close();
  } finally { globalThis.fetch = original; }
});

test('shutdown waits for tieba and reports timeout, reentrant signals stop once', async () => {
  const signals = new EventEmitter(); let stops = 0; let resolveExit;
  const exited = new Promise(resolve => { resolveExit = resolve; });
  signals.exit = resolveExit;
  setupProductionFanqie({ cfg: {}, signals, shutdownTimeoutMs: 30, start: () => ({stop() { stops++; }}), tieba: {stop: () => new Promise(() => {})} });
  signals.emit('SIGTERM'); signals.emit('SIGINT');
  assert.equal(await exited, 1);
  assert.equal(stops, 1);
});

test('shutdown waits for every stop even when one rejects', async () => {
  const signals = new EventEmitter(); const exits = []; let release;
  signals.exit = code => exits.push(code);
  setupProductionFanqie({ cfg: {}, signals, shutdownTimeoutMs: 1000, start: () => ({stop() {}}),
    stopOthers: () => [Promise.reject(new Error('failed')), new Promise(r => { release = r; })] });
  signals.emit('SIGINT');
  await new Promise(r => setTimeout(r, 10)); assert.deepEqual(exits, []);
  release(); await new Promise(r => setTimeout(r, 10)); assert.deepEqual(exits, [1]);
});

test('timeout produces only one exit even if a stop later settles', async () => {
  const signals = new EventEmitter(); const exits = []; let release;
  signals.exit = code => exits.push(code);
  setupProductionFanqie({ cfg: {}, signals, shutdownTimeoutMs: 15, start: () => ({ stop: () => new Promise(r => { release = r; }) }) });
  signals.emit('SIGTERM');
  await new Promise(r => setTimeout(r, 30)); release();
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(exits, [1]);
});

