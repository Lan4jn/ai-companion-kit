import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register('./onebot-no-network-loader.js', import.meta.url);
const { OneBot } = await import('../src/transport-onebot.js');

test('OneBot send requires a confirmed successful protocol response', async () => {
  const old = globalThis.fetch;
  let body = { status: 'failed', retcode: 100, message: 'rejected' };
  globalThis.fetch = async () => ({ ok: true, text: async () => JSON.stringify(body) });
  try {
    const bot = new OneBot({ httpUrl: 'http://never-used', wsUrl: 'ws://never-used' });
    let r = await bot.send('group:1', 'hello');
    assert.equal(r.ok, false); assert.equal(r.outcome, 'permanent');
    body = { status: 'ok', retcode: 100 };
    r = await bot.send('group:1', 'hello'); assert.equal(r.ok, false);
    body = { random: 'value' };
    r = await bot.send('group:1', 'hello'); assert.equal(r.ok, false); assert.equal(r.outcome, 'unknown');
    body = { status: 'async', retcode: 1 };
    r = await bot.send('group:1', 'hello'); assert.equal(r.outcome, 'unknown');
    body = { status: 'ok', retcode: 0, data: { message_id: 42 } };
    r = await bot.send('group:1', 'hello'); assert.equal(r.ok, true);
    globalThis.fetch = async () => { throw new Error('timeout'); };
    r = await bot.send('group:1', 'hello'); assert.equal(r.outcome, 'unknown');
  } finally { globalThis.fetch = old; }
});
