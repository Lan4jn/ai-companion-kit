import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHongguoIntegration } from '../src/hongguo-integration.js';

let originalSerial;
beforeEach(() => { originalSerial = process.env.PHONE_SERIAL; process.env.PHONE_SERIAL = 'emulator-5554'; });
afterEach(() => { if (originalSerial === undefined) delete process.env.PHONE_SERIAL; else process.env.PHONE_SERIAL = originalSerial; });

test('busy shared phone mutex skips a tick without touching the device', async () => {
  let calls = 0;
  const mutex = { tryBackground: async () => false };
  const integration = createHongguoIntegration({ enabled: true, serial: 'emulator-5554', packageName: 'com.example.hongguo', mutex, run: async () => { calls++; throw Error('unexpected'); } });
  const result = await integration.tick({ permission: true, brain: { complete: async () => '{"want":true}' } });
  assert.equal(result.status, 'busy');
  assert.equal(calls, 0);
});

test('integration is disabled by default and does not invoke dependencies', async () => {
  let calls = 0;
  const integration = createHongguoIntegration({ serial: 'emulator-5554', packageName: 'com.example.hongguo', run: async () => { calls++; throw Error('unexpected'); } });
  assert.equal((await integration.tick({ permission: true, brain: { complete: async () => '{"want":true}' } })).status, 'disabled');
  assert.equal(calls, 0);
});

test('enabled integration observes adapter output without inventing audio', async () => {
  let shot = 0;
  let time = 0;
  const run = async (cmd, args) => {
    assert.equal(cmd, 'adb'); assert.deepEqual(args.slice(0, 2), ['-s', 'emulator-5554']);
    const request = args.slice(2).join(' ');
    if (request === 'shell dumpsys activity activities') return { stdout: 'mResumedActivity: ActivityRecord{a u0 com.example.hongguo/.Main t1}' };
    if (request === 'shell dumpsys media_session') return { stdout: `com.example.hongguo/session (userId=0)\n state=PlaybackState {state=3, position=${(shot + 1) * 1000}, speed=1.0}\n android.media.metadata.MEDIA_ID=ep1` };
    if (request === 'exec-out screencap -p') return { stdout: Buffer.from(`image${++shot}`) };
    throw Error(request);
  };
  const integration = createHongguoIntegration({ enabled: true, serial: 'emulator-5554', packageName: 'com.example.hongguo', run, now: () => ++time, recognize: async () => ['画面文字'], wait: async () => {} });
  const result = await integration.tick({ permission: true, brain: { complete: async () => '{"want":true}' } });
  assert.equal(result.status, 'verified');
  assert.equal(result.assessment.evidence.audio, null);
  assert.deepEqual(result.assessment.evidence.subtitles, []);
  assert.equal(shot, 2);
});

test('offline failure latches stop and forbids later retries', async () => {
  let calls = 0;
  const integration = createHongguoIntegration({ enabled: true, serial: 'emulator-5554', packageName: 'com.example.hongguo', run: async () => { calls++; throw Error('device offline'); }, intervalMs: 1 });
  const options = { permission: true, brain: { complete: async () => '{"want":true}' } };
  assert.equal((await integration.tick(options)).status, 'stopped');
  assert.equal((await integration.tick(options)).status, 'stopped');
  assert.equal(calls, 1);
});

test('configured dedicated MuMu TCP serial is accepted and every operation targets it', async () => {
  const prior = process.env.PHONE_SERIAL;
  process.env.PHONE_SERIAL = '192.168.31.160:16384';
  try {
    let calls = 0;
    const integration = createHongguoIntegration({ enabled: true, serial: process.env.PHONE_SERIAL, packageName: 'com.example.hongguo', run: async (cmd, args) => {
      calls++;
      assert.equal(cmd, 'adb');
      assert.deepEqual(args.slice(0, 2), ['-s', '192.168.31.160:16384']);
      throw Error('device offline');
    } });
    const options = { permission: true, brain: { complete: async () => '{"want":true}' } };
    assert.equal((await integration.tick(options)).status, 'stopped');
    assert.equal((await integration.tick(options)).status, 'stopped');
    assert.equal(calls, 1);
  } finally {
    if (prior === undefined) delete process.env.PHONE_SERIAL; else process.env.PHONE_SERIAL = prior;
  }
});

test('a changed PHONE_SERIAL stops an existing integration before any adb call', async () => {
  const prior = process.env.PHONE_SERIAL;
  process.env.PHONE_SERIAL = '192.168.31.160:16384';
  try {
    let calls = 0;
    const integration = createHongguoIntegration({ enabled: true, serial: process.env.PHONE_SERIAL, packageName: 'com.example.hongguo', run: async () => { calls++; throw Error('unexpected'); } });
    process.env.PHONE_SERIAL = '192.168.31.161:5555';
    const result = await integration.tick({ permission: true, brain: { complete: async () => '{"want":true}' } });
    assert.equal(result.status, 'stopped');
    assert.equal(calls, 0);
  } finally {
    if (prior === undefined) delete process.env.PHONE_SERIAL; else process.env.PHONE_SERIAL = prior;
  }
});

test('an emulator serial must be explicitly pinned', () => {
  for (const serial of [undefined, 'phone1', 'emulator-5554;other', 'emulator-5556', '192.168.31.160:16384']) assert.throws(() => createHongguoIntegration({ enabled: true, serial, packageName: 'com.example.hongguo' }), /模拟器/);
  delete process.env.PHONE_SERIAL;
  assert.throws(() => createHongguoIntegration({ enabled: true, serial: 'emulator-5554', packageName: 'com.example.hongguo' }), /PHONE_SERIAL/);
});
