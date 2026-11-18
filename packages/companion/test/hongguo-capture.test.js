import test from 'node:test';
import assert from 'node:assert/strict';
import { observeHongguo, createAdbCapture, recognizeScreen } from '../src/hongguo-capture.js';
import { execFileSync } from 'node:child_process';

const frame = n => ({ serial: 'phone1', packageName: 'com.example.hongguo', state: 'playing', episodeId: 'ep1', positionMs: n * 1000, capturedAt: n * 1000, image: Buffer.from(`frame${n}`) });
const run = (capture, recognize = async () => ['等我']) => observeHongguo({ serial: 'phone1', packageName: 'com.example.hongguo', capture, recognize, wait: async () => {} });

test('two injected observations are assessed and OCR is attributed to screen', async () => {
  let n = 0;
  const result = await run(async () => frame(++n));
  assert.equal(result.verified, true);
  assert.deepEqual(result.evidence.screenText, [['等我'], ['等我']]);
  assert.deepEqual(result.evidence.subtitles, []);
  assert.equal(result.evidence.audio, null);
});

test('device, application, agreement, login and unavailable evidence fail closed', async () => {
  for (const shot of [{ ...frame(1), serial: 'other' }, { ...frame(1), packageName: 'other' }, { ...frame(1), state: 'consent' }, { ...frame(1), image: Buffer.alloc(0) }]) {
    assert.equal((await run(async () => shot)).verified, false);
  }
  for (const lines of [['用户协议', '同意并继续'], ['请先登录'], []]) {
    assert.equal((await run(async () => frame(1), async () => lines)).verified, false);
  }
  assert.equal((await run(async () => { throw Error('offline'); })).verified, false);
  assert.equal((await run(async () => frame(1), async () => { throw Error('OCR missing'); })).verified, false);
});

test('unchanged frame, no progress and episode changes cannot prove watching', async () => {
  for (const mutate of [x => ({ ...x, image: Buffer.from('same') }), x => ({ ...x, positionMs: 0 }), x => ({ ...x, episodeId: `ep${x.positionMs}` })]) {
    let n = 0;
    assert.equal((await run(async () => mutate(frame(++n)))).verified, false);
  }
});

test('ADB adapter pins serial and rejects changing foreground', async () => {
  let calls = 0;
  const fakeRun = async (command, args) => {
    assert.equal(command, 'adb'); assert.deepEqual(args.slice(0, 2), ['-s', 'phone1']);
    calls++;
    return { stdout: Buffer.from(calls === 2 ? 'png' : `mResumedActivity: ActivityRecord{a u0 ${calls === 3 ? 'other.app' : 'com.example.hongguo'}/.Main t1}`) };
  };
  const capture = createAdbCapture({ serial: 'phone1', packageName: 'com.example.hongguo', playback: async () => ({ state: 'playing' }), run: fakeRun });
  await assert.rejects(capture(), /前台应用/);
});

test('real Tesseract receives image via stdin', { skip: process.env.PATH ? false : 'no PATH' }, async t => {
  let image;
  try { image = execFileSync('convert', ['-size', '700x150', 'xc:white', '-fill', 'black', '-font', 'DejaVu-Sans', '-pointsize', '64', '-gravity', 'center', '-annotate', '0', 'HELLO WORLD', 'png:-'], { stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return t.skip('ImageMagick unavailable'); }
  try { assert.match((await recognizeScreen(image, { language: 'eng' })).join(' '), /HELLO WORLD/i); }
  catch (e) { if (e.code === 'ENOENT') return t.skip('Tesseract unavailable'); throw e; }
});

test('visual playback requires same OCR identity, advancing playhead and changed frame', async () => {
 let n=0; const capture=async()=>({serial:'phone1',packageName:'com.example.hongguo',state:'screen',image:Buffer.from(String(++n)),capturedAt:n*3000});
 const recognize=async()=>['第9集','下山奶爸，医武双绝藏不住了 >'];
 const result=await observeHongguo({serial:'phone1',packageName:'com.example.hongguo',capture,recognize,wait:async()=>{},screenProgress: async image => image.toString()==='1'?.2:.23});
 assert.equal(result.verified,true); assert.equal(result.evidence.playback.source,'screen-progress'); assert.equal(result.evidence.playback.positionMs,undefined);
});

test('screen playback verifies independently captured OCR identities with minor title errors', async () => {
 let n=0;
 const result=await observeHongguo({serial:'phone1',packageName:'com.example.hongguo',capture:async()=>({serial:'phone1',packageName:'com.example.hongguo',state:'screen',image:Buffer.from(String(++n)),capturedAt:n*3000}),recognize:async()=>['实际画面文字'],screenIdentity:async image=>image.toString()==='1'?'下山奶管细医武双绝藏不住了:第10集':'下山奶爸，医武双绝藏不住了:第10集',screenProgress:async image=>image.toString()==='1'?.2:.23,wait:async()=>{}});
 assert.equal(result.verified,true);
});
