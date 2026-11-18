import {test} from 'node:test';import assert from 'node:assert/strict';import {turnFanqiePage} from '../src/fanqie-session.js';
test('仅在确认为阅读页并验证正文改变后报告翻页',async()=>{let n=0;const r=await turnFanqiePage({capture:async()=>({text:++n===1?'从前有一个在城中生活的少年，他每天都会去学校读书。'.repeat(4):'当天晚上少年离开学校，遇见了站在大门前的朋友。'.repeat(4),fingerprint:String(n)}),turn:async()=>true});assert.equal(r.ok,true)});
test('未验证成功翻页时不可报告进度',async()=>{const p={text:'没有变化的正文'.repeat(20),fingerprint:'same'};assert.equal((await turnFanqiePage({capture:async()=>p,turn:async()=>true})).ok,false)});
test('无法阅读时不翻页',async()=>{let n=0;const r=await turnFanqiePage({capture:async()=>null,turn:async()=>n++});assert.equal(r.ok,false);assert.equal(n,0)});
