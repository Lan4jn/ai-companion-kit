import test from 'node:test';
import assert from 'node:assert/strict';
import { __debug } from '../src/bili-living.js';

test('partial recording fails closed without authorized forget filter', async () => {
 let calls=0;
 const result=await __debug.rememberSkippedFeeling({brain:{complete:async()=>{calls++;return '{}';}},memory:{logDiary(){throw Error('must not write');}},bvid:'BV1234567890',duration:10,coverage:{},browserResult:{},filter:null});
 assert.equal(result,null); assert.equal(calls,0);
});
