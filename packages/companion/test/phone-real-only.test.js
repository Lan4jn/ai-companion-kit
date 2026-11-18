import {test} from 'node:test';
import assert from 'node:assert/strict';
import {getPhoneLivingStatus, startPhoneLiving, stopPhoneLiving} from '../src/phone-living.js';
test('未启用真实自主操作时不能产生虚构手机经历', async () => {
 startPhoneLiving();
 await new Promise(r => setTimeout(r, 3200));
 const s=getPhoneLivingStatus();
 stopPhoneLiving();
 assert.equal(s.mode,'unavailable');
 assert.doesNotMatch(JSON.stringify(s),/搞笑短视频|刚刷到|周杰伦|第 6 层/);
});
