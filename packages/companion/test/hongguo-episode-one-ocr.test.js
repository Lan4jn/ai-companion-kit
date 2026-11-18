import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recognizeScreenIdentity } from '../src/hongguo-capture.js';

test('episode 1 can be read using sparse-text OCR when single-line OCR misses it', async () => {
  const image = Buffer.alloc(24); image.writeUInt32BE(1920, 16); image.writeUInt32BE(1080, 20);
  const ocrCrop = async (geometry, psm) => geometry.startsWith('650') ? '和离后我带女儿横扫魔域' : (psm === 11 ? '第1集' : 'FE');
  assert.equal(await recognizeScreenIdentity(image, { ocrCrop }), '和离后我带女儿横扫魔域:第1集');
});

test('conflicting episode OCR results fail closed', async () => {
  const image = Buffer.alloc(24); image.writeUInt32BE(1920, 16); image.writeUInt32BE(1080, 20);
  const ocrCrop = async (geometry, psm) => geometry.startsWith('650') ? '和离后我带女儿横扫魔域' : (psm === 11 ? '第1集' : '第2集');
  assert.equal(await recognizeScreenIdentity(image, { ocrCrop }), null);
});
