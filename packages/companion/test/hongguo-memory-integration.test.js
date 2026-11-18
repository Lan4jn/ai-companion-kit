import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHongguoIntegration } from '../src/hongguo-integration.js';
import { recallHongguo } from '../src/hongguo-memory.js';

test('verified playback can save and recall a selectively interesting OCR observation', async t => {
  const previousSerial = process.env.PHONE_SERIAL;
  process.env.PHONE_SERIAL = 'emulator-5554';
  t.after(() => { if (previousSerial === undefined) delete process.env.PHONE_SERIAL; else process.env.PHONE_SERIAL = previousSerial; });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hongguo-test-'));
  try {
    let shot = 0, clock = 0;
    const run = async (_cmd, args) => {
      const request = args.slice(2).join(' ');
      if (request === 'shell dumpsys activity activities') return { stdout: 'mResumedActivity: ActivityRecord{a u0 com.example.hongguo/.Main t1}' };
      if (request === 'shell dumpsys media_session') return { stdout: `com.example.hongguo/session (userId=0)\n state=PlaybackState {state=3, position=${(shot + 1) * 1000}, speed=1.0}\n android.media.metadata.MEDIA_ID=ep1` };
      if (request === 'exec-out screencap -p') return { stdout: Buffer.from(`image${++shot}`) };
      throw Error(request);
    };
    const integration = createHongguoIntegration({ enabled: true, serial: 'emulator-5554', packageName: 'com.example.hongguo', run, mutex: { tryBackground: async fn => { await fn(); return true; } }, memoryDir: dir, now: () => ++clock, recognize: async () => ['车站再见'], wait: async () => {} });
    let calls = 0;
    const brain = { complete: async () => ++calls === 1 ? '{"want":true}' : '{"interested":true,"summary":"屏幕文字提到车站再见","keywords":["车站"]}' };
    const result = await integration.tick({ permission: true, brain });
    assert.equal(result.status, 'verified');
    assert.equal(result.memory.status, 'saved');
    const records = await recallHongguo(dir, '车站');
    assert.equal(records.length, 1);
    assert.equal(records[0].episodeId, 'ep1');
    assert.equal(records[0].progress.positionMs, 2000);
    assert.match(records[0].source, /OCR/);
    assert.equal(records[0].audio, null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
