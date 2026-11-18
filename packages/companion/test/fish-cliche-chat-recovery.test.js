import test from 'node:test';
import assert from 'node:assert/strict';
import { Brain } from '../src/brain.js';

const brain=()=>new Brain({apiKey:'fixture',baseUrl:'https://example.invalid',model:'test',memory:{getHistory:()=>[],addMessage:()=>{},getSummary:()=>''}});
const response=(content,finish_reason='stop')=>({ok:true,text:async()=>JSON.stringify({choices:[{finish_reason,message:{content}}]})});
const reply=(b,key,text='你好')=>b.reply({key,userId:'42',text,history:[],record:false,addressed:true});

test('new standalone variants fail visibly without a rewrite or extra tool calls',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return response('这句我记下了。')});
 const r=await reply(brain(),'private:new-fish');assert.equal(r.reason,'fish_cliche');assert.equal(calls,1);
});
test('long factual answer stays verbatim without rewriting',async t=>{
 const original='这条我认。价格是 500 元（含税），保修三年。\n```js\nconsole.log(42)\n```';let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return response(original)});
 const r=await reply(brain(),'private:long-fish');assert.equal(r.text,original);assert.equal(calls,1);
});
test('short standalone acknowledgment has one tool-free rewrite, preserving intent',async t=>{
 const requests=[];t.mock.method(globalThis,'fetch',async(_u,o)=>{requests.push(JSON.parse(o.body));return response(requests.length===1?'这条我认。':'说得对。')});
 assert.equal((await reply(brain(),'private:short-fish')).text,'说得对。');assert.equal(requests.length,2);assert.equal(requests[1].tools,undefined);assert.equal(requests[1].tool_choice,undefined);
});
test('unverifiable rewrite fails visibly without releasing original',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>response(++calls===1?'这句我认。':'价格50元'));
 assert.equal((await reply(brain(),'group:rewrite-invalid')).reason,'fish_cliche');assert.equal(calls,2);
});
test('wechat private and group apply same rewrite detection',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>response(++calls%2?'这话我认。':'没错。'));
 for(const key of ['wx:private:fixture','wx:group:fixture']) assert.equal((await reply(brain(),key)).text,'没错。');
 assert.equal(calls,4);
});
test('failed rewrite reports failure without retrying',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;if(calls===1)return response('这条我认。');throw new Error('fixture timeout')});
 assert.equal((await reply(brain(),'private:rewrite-failed')).reason,'fish_cliche');assert.equal(calls,2);
});
test('incomplete completion is explicitly reported rather than silent',async t=>{
 t.mock.method(globalThis,'fetch',async()=>response('未完','length'));
 const r=await reply(brain(),'private:incomplete-fish');assert.ok(r.text);assert.notEqual(r.text,'未完');assert.notEqual(r.blocked,true);
});


test('non-hongguo whitelist: technical and quoted material is preserved on QQ and WeChat',async t=>{
 const original='报价 500 元（含税）。\n```js\nconsole.log((2 + 3))\n```\n引用：“这条我认”。';let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return response(original)});
 for(const key of ['private:fixture-tech','group:fixture-tech','wx:private:fixture-tech','wx:group:fixture-tech']) assert.equal((await reply(brain(),key,'解释代码')).text,original);
 assert.equal(calls,4);
});
