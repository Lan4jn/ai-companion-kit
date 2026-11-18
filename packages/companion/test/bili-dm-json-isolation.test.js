import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBiliDMReply } from '../src/bili-living.js';
test('DM reply parser accepts only a strict JSON object and boolean decision',()=>{
 assert.equal(parseBiliDMReply('{"reply":true,"text":"你好"}'),'你好');
 for(const raw of ['prefix {"reply":true,"text":"x"}','{"reply":"false","text":"x"}','{"reply":true,"text":7}','{"reply":false,"text":"x"}','{"reply":true,"text":" "}','{"reply":true,"text":"x"} trailing']) assert.equal(parseBiliDMReply(raw),null,raw);
});
