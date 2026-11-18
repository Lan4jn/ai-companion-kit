import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recognizeScreenIdentity } from '../src/hongguo-capture.js';

test('title OCR uses full player title and ignores the chevron', async () => {
 const image=Buffer.alloc(24); image.writeUInt32BE(1920,16); image.writeUInt32BE(1080,20);
 const ocrCrop=async (geometry,psm)=>geometry.includes('+15+790') ? '全球死考: 刚下刑场你让我去考试一季>' : geometry.includes('+65+50') ? '第2集' : '全球死考: 刚下刑场你让我去考试';
 assert.equal(await recognizeScreenIdentity(image,{ocrCrop}),'全球死考: 刚下刑场你让我去考试一季:第2集');
});
