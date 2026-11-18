import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recognizeScreenIdentity } from '../src/hongguo-capture.js';
import { detectPlayhead } from '../src/hongguo-screen-progress.js';

test('portrait player reads show identity from the title and episode regions', async () => {
  const image = Buffer.alloc(24); image.writeUInt32BE(1080, 16); image.writeUInt32BE(1920, 20);
  const ocrCrop = async (geometry, psm) => geometry.includes('+15+1630') ? (psm === 11 ? '重回1977: 从一把猎枪开始赶山娶老婆' : '重回1977: 从一把错枪开始赶山要老波') : '第2集';
  assert.equal(await recognizeScreenIdentity(image, { ocrCrop }), '重回1977: 从一把猎枪开始赶山娶老婆:第2集');
});

test('portrait player reads the calibrated bottom playhead', () => {
  const width=1080, height=1920, data=Buffer.alloc(width*height*3);
  for(let y=1817;y<=1822;y++) for(let x=617;x<=623;x++) data.fill(255,(y*width+x)*3,(y*width+x)*3+3);
  const value=detectPlayhead({data,width,height});
  assert.ok(Number.isFinite(value) && value > 0.55 && value < 0.60);
});
