import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setupProductionFanqie } from '../src/index.js';

test('shutdown drains transport only after async producers stop', async () => {
  const signals = new EventEmitter();
  let release; const events = [];
  const exited = new Promise(resolve => { signals.exit = resolve; });
  setupProductionFanqie({ cfg: {}, signals, shutdownTimeoutMs: 1000,
    start: () => ({ stop: async () => { await new Promise(r => { release = r; }); events.push('producer stopped'); } }),
    drain: async () => { events.push('transport drained'); },
  });
  signals.emit('SIGTERM');
  await new Promise(r => setImmediate(r));
  assert.deepEqual(events, []);
  release();
  assert.equal(await exited, 0);
  assert.deepEqual(events, ['producer stopped', 'transport drained']);
});
