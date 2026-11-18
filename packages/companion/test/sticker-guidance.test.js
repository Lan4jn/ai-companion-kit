import {test} from 'node:test';import assert from 'node:assert/strict';import {stickerGuidance} from '../src/sticker-guidance.js';
test('未识别的图片不允许假装理解',()=>{const x=stickerGuidance({seen:false,hasText:false});assert.match(x,/看不清|未识别/);assert.doesNotMatch(x,/直接甩|回敬|笑屁/)});
test('能看到时允许结合上下文而非强制怼人',()=>{const x=stickerGuidance({seen:true,hasText:true});assert.match(x,/上下文/);assert.doesNotMatch(x,/必须.*怼|直接甩/)});
