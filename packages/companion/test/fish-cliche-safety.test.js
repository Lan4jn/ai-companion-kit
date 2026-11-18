import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Brain } from '../src/brain.js';

const makeBrain = () => new Brain({ apiKey:'test', baseUrl:'https://example.invalid', model:'test', memory:{ getHistory:()=>[], addMessage:()=>{}, getSummary:()=>'' } });
function response(content) { const data={choices:[{finish_reason:'stop',message:{content}}]}; return {ok:true,text:async()=>JSON.stringify(data),json:async()=>data}; }

test('a factual answer remains unchanged without model rewrite', async t => {
 let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{ calls++; return response(calls===1?'这条我认。价格是 500 元，保修三年。':'价格是 50 元。'); });
 const r=await makeBrain().reply({key:'group:safety-fact-unique',userId:'42',text:'请看看',history:[],record:false});
 assert.equal(r.text,'这条我认。价格是 500 元，保修三年。'); assert.equal(calls,1);
});

test('unflagged factual content preserves parentheses and markdown exactly', async t => {
 const s='价格为 500 元（含税），参考 https://example.com/a。\n\n**注意**：不含运费。';
 t.mock.method(globalThis,'fetch',async()=>response(s));
 const r=await makeBrain().reply({key:'group:safety-exact-unique',userId:'42',text:'请看看',history:[],record:false});
 assert.equal(r.text,s);
});
