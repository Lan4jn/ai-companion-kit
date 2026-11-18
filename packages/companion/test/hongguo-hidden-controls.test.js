import test from 'node:test';
import assert from 'node:assert/strict';
import { observeHongguo } from '../src/hongguo-capture.js';

test('capture both player frames before slow OCR hides episode controls', async () => {
  let n=0, ocrStarted=false;
  const result=await observeHongguo({ serial:'phone1', packageName:'app',
    capture:async()=>({serial:'phone1',packageName:'app',state:'screen',image:Buffer.from(`${++n}:${ocrStarted?'hidden':'visible'}`),capturedAt:n*3000}),
    recognize:async()=>{ocrStarted=true; return ['可见画面文字'];},
    screenIdentity:async image=> image.toString().endsWith('visible') ? '重回1977从一把猎枪开始赶山娶老婆:第8集' : null,
    screenProgress:async image=>image.toString().startsWith('1:')?.2:.23, wait:async()=>{},
  });
  assert.equal(result.verified,true);
});
