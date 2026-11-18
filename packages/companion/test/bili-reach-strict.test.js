import test from 'node:test';
import assert from 'node:assert/strict';
import { __debug } from '../src/bili-living.js';

test('reach requires explicit boolean and valid independent channel', async () => {
  for (const value of [
    {want:'false',via:'invalid',say:'测试私信'},
    {want:'true',via:'comment',say:'视频很有意思'},
    {want:1,via:'comment',say:'视频很有意思'},
    {want:true,via:'invalid',say:'测试私信'},
    {want:true,say:'测试私信'},
  ]) assert.equal(await __debug.shouldReachOut({reply:async()=>({text:JSON.stringify(value)})},{},''), null);
  assert.equal((await __debug.shouldReachOut({reply:async()=>({text:'{"want":true,"via":"dm","say":"测试私信"}'})},{},'')).via, 'dm');
  assert.deepEqual(await __debug.shouldReachOut({reply:async()=>({text:'{"want":true,"via":"comment","say":"视频很有意思"}'})},{},''), {via:'comment',say:'视频很有意思'});
});
