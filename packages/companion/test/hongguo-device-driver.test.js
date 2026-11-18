import test from 'node:test';
import assert from 'node:assert/strict';
import { createHongguoDeviceDriver } from '../src/hongguo-device-driver.js';
import { createAdbCapture, observeHongguo } from '../src/hongguo-capture.js';

test('reads a matching playing media session without controlling the device', async () => {
  const calls = [];
  const run = async (_cmd, args) => {
    calls.push(args);
    const out = args.includes('media_session') ? `Sessions Stack - have 1 sessions:\n  com.example.drama/Player (userId=0)\n    state=PlaybackState {state=3, position=1234, buffered position=0, speed=1.0}\n    metadata: description=Test, android.media.metadata.MEDIA_ID=episode-1` : 'mResumedActivity: ActivityRecord{a u0 com.example.drama/.Main t1}';
    return { stdout: Buffer.from(out) };
  };
  const driver = createHongguoDeviceDriver({ serial: 'phone1', packageName: 'com.example.drama', run });
  assert.deepEqual(await driver.playback(), { state: 'playing', episodeId: 'episode-1', positionMs: 1234 });
  assert.ok(calls.every(a => a[0] === '-s' && a[1] === 'phone1'));
  assert.ok(calls.every(a => !a.includes('input')));
});

test('navigation refuses without a freshly observed unique configured control', async () => {
  const calls = [];
  const run = async (_cmd, args) => {
    calls.push(args);
    if (args.includes('activities')) return { stdout: 'mResumedActivity: ActivityRecord{a u0 com.example.drama/.Main t1}' };
    if (args.includes('uiautomator')) return { stdout: '<hierarchy><node resource-id="com.example.drama:id/play" text="播放" bounds="[10,20][50,60]" clickable="true" enabled="true" /></hierarchy>' };
    return { stdout: '' };
  };
  const driver = createHongguoDeviceDriver({ serial: 'phone1', packageName: 'com.example.drama', run });
  await assert.rejects(driver.tapControl({ resourceId: 'com.example.drama:id/other' }));
  assert.ok(!calls.some(a => a.includes('input')));
  await driver.tapControl({ resourceId: 'com.example.drama:id/play' });
  assert.deepEqual(calls.filter(a => a.includes('input')).map(a => a.slice(-2)), [['30', '40']]);
});

test('refuses changed controls, agreement screens, and ambiguous matches', async () => {
  for (const kind of ['changed', 'agreement', 'duplicate']) {
    const calls = []; let dumps = 0;
    const run = async (_cmd, args) => {
      calls.push(args);
      if (args.includes('activities')) return { stdout: 'mResumedActivity: ActivityRecord{a u0 com.example.drama/.Main t1}' };
      if (args.includes('uiautomator')) {
        dumps++;
        const x = kind === 'changed' && dumps > 1 ? 11 : 10;
        const node = `<node resource-id="com.example.drama:id/play" bounds="[${x},20][50,60]" clickable="true" enabled="true" />`;
        return { stdout: `<hierarchy>${node}${kind === 'duplicate' ? node : ''}${kind === 'agreement' ? '<node text="用户协议" />' : ''}</hierarchy>` };
      }
      return { stdout: '' };
    };
    const driver = createHongguoDeviceDriver({ serial: 'phone1', packageName: 'com.example.drama', run });
    await assert.rejects(driver.tapControl({ resourceId: 'com.example.drama:id/play' }));
    assert.ok(!calls.some(a => a.includes('input')), kind);
  }
});

test('rejects unknown or switched foreground and non-playing sessions', async () => {
  for (const kind of ['unknown', 'switched', 'paused', 'missing-id', 'duplicate']) {
    let reads = 0;
    const run = async (_cmd, args) => {
      if (args.includes('activities')) {
        reads++;
        return { stdout: kind === 'unknown' ? 'unknown' : `mResumedActivity: ActivityRecord{a u0 ${kind === 'switched' && reads > 1 ? 'other.app' : 'com.example.drama'}/.Main t1}` };
      }
      const entry = `  com.example.drama/Player (userId=0)\n    state=PlaybackState {state=${kind === 'paused' ? 2 : 3}, position=1234, buffered position=0, speed=1.0}\n    metadata: ${kind === 'missing-id' ? '' : 'android.media.metadata.MEDIA_ID=episode-1'}`;
      return { stdout: `Sessions Stack - have sessions:\n${entry}${kind === 'duplicate' ? `\n${entry}` : ''}` };
    };
    const driver = createHongguoDeviceDriver({ serial: 'phone1', packageName: 'com.example.drama', run });
    await assert.rejects(driver.playback(), undefined, kind);
  }
});

test('driver playback composes with capture and existing two-frame assessment', async () => {
  let position = 0, shots = 0, time = 0;
  const run = async (_cmd, args) => {
    if (args.includes('activities')) return { stdout: 'mResumedActivity: ActivityRecord{a u0 com.example.drama/.Main t1}' };
    if (args.includes('media_session')) return { stdout: `Sessions Stack:\n  com.example.drama/Player (userId=0)\n    state=PlaybackState {state=3, position=${position += 3000}, buffered position=0, speed=1.0}\n    metadata: android.media.metadata.MEDIA_ID=episode-1` };
    if (args.includes('screencap')) return { stdout: Buffer.from(`frame${++shots}`) };
    throw new Error('unexpected command');
  };
  const serial = 'phone1', packageName = 'com.example.drama';
  const driver = createHongguoDeviceDriver({ serial, packageName, run });
  const capture = createAdbCapture({ serial, packageName, playback: driver.playback, run, now: () => time += 3000 });
  const result = await observeHongguo({ serial, packageName, capture, recognize: async () => ['可见文字'], wait: async () => {} });
  assert.equal(result.verified, true);
});

test('missing media session can explicitly fall back to screen observation', async()=>{
 const run=async (_cmd,args)=>({stdout:args.join(' ').includes('media_session')?'no sessions':'mResumedActivity: ActivityRecord{a u0 com.example.drama/.Main t1}'});
 const driver=createHongguoDeviceDriver({serial:'phone1',packageName:'com.example.drama',run});
 assert.deepEqual(await driver.playback({screenFallback:true}),{state:'screen'});
});
