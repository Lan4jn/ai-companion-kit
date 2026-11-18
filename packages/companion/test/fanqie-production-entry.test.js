import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setupProductionFanqie } from '../src/index.js';

test('production defaults to disabled and registers shutdown without exposing context', () => {
  const signals = new EventEmitter(); let options; let stops = 0; let exit;
  signals.exit = code => { exit = code; };
  setupProductionFanqie({ cfg: { dataDir: '/data' }, brain: {}, signals,
    start: o => { options = o; return { stop() { stops++; } }; } });
  assert.equal(options.enabled, false);
  assert.equal(options.context, undefined);
  signals.emit('SIGINT');
  assert.equal(stops, 1);
  assert.equal(exit, 0);
});

test('explicit opt-in passes required dependencies and stops once on SIGTERM', () => {
  const signals = new EventEmitter(); signals.exit = () => {};
  const brain = {}; let received; let stops = 0;
  setupProductionFanqie({ cfg: { fanqie: { enabled: true, serial: 'device' }, dataDir: '/data' }, brain, signals,
    start: options => { received = options; return { stop: () => stops++ }; } });
  assert.equal(typeof received.historyFilter, 'function');
  const {historyFilter, ...dependencies} = received;
  assert.deepEqual(dependencies, { enabled: true, serial: 'device', brain, dataDir: '/data' });
  signals.emit('SIGTERM'); signals.emit('SIGINT');
  assert.equal(stops, 1);
});

test('dry run and non-boolean flags cannot enable reading', () => {
  for (const cfg of [{ fanqie: { enabled: true }, dryRun: true }, { fanqie: { enabled: 'true' } }]) {
    const signals = new EventEmitter(); signals.exit = () => {};
    let enabled;
    setupProductionFanqie({ cfg, signals, start: options => { enabled = options.enabled; return { stop() {} }; } });
    assert.equal(enabled, false);
  }
});

test('startup errors are isolated and sensitive error details are not logged', () => {
  const signals = new EventEmitter(); let exit; signals.exit = code => { exit = code; };
  const warn = console.warn; const logs = []; console.warn = (...args) => logs.push(args.join(' '));
  try {
    assert.doesNotThrow(() => setupProductionFanqie({ cfg: { fanqie: { enabled: true } }, signals,
      start() { throw Error('sensitive-device-state'); } }));
    signals.emit('SIGTERM');
    assert.equal(exit, 0);
    assert.ok(logs.length);
    assert.ok(!logs.join(' ').includes('sensitive-device-state'));
  } finally { console.warn = warn; }
});
