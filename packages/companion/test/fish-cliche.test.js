import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasFishCliche } from '../src/fish-cliche.js';

test('flags conversational canned claims but preserves quoted text and code', () => {
  assert.equal(hasFishCliche('这条我认。你说得对'), false);
  assert.equal(hasFishCliche('“这条我认”是什么意思？'), false);
  assert.equal(hasFishCliche('`这条我认` 是示例'), false);
  assert.equal(hasFishCliche('这条我认同你的看法'), false);
});

import { Brain } from '../src/brain.js';
test('QQ rejects unverifiable standalone acknowledgement rewrite', async t => {
  const bodies=[]; const records=[];
  t.mock.method(globalThis, 'fetch', async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    const content = bodies.length === 1 ? '这条我认。' : '那就这么办吧。';
    const response={choices:[{message:{content}}]}; return {ok:true,text:async()=>JSON.stringify(response),json:async()=>response};
  });
  const brain=new Brain({apiKey:'test',baseUrl:'https://test.invalid',role:{build:()=>''},memory:{render:()=>'',remember:(_id,x)=>records.push(x),logTurn:x=>records.push(x)},dataDir:process.env.TMPDIR});
  const result=await brain.reply({key:'group:fish-test-1',userId:'42',text:'你好',history:[],record:false});
  assert.equal(result.reason,'fish_cliche'); assert.match(result.text,/没能安全生成/);
  assert.equal(bodies.length,2); assert.equal(bodies[1].tools,undefined);
});

test('factual drafts are preserved without recording or tool retries', async t => {
  const bodies=[]; let records=0;
  t.mock.method(globalThis, 'fetch', async (_u,o)=>{ bodies.push(JSON.parse(o.body)); const data={choices:[{message:{content:'我接住了。正文不能丢失。'}}]};return {ok:true,text:async()=>JSON.stringify(data),json:async()=>data}; });
  const brain=new Brain({apiKey:'test',baseUrl:'https://test.invalid',role:{build:()=>''},memory:{render:()=>'',remember:()=>records++,logTurn:()=>records++},dataDir:process.env.TMPDIR});
  const result=await brain.reply({key:'group:fish-test-2',userId:'42',text:'你好',record:false});
  assert.equal(result.text,'我接住了。正文不能丢失。'); assert.equal(bodies.length,1); assert.equal(records,0);
});

test('voice wording is rejected before synthesis', async t => {
 const bodies=[];
 t.mock.method(globalThis,'fetch',async (_u,o)=>{ bodies.push(JSON.parse(o.body)); const msg=bodies.length===1?{tool_calls:[{id:'v',type:'function',function:{name:'voice_say',arguments:JSON.stringify({text:'这条我认。'})}}]}:{content:'好呀。'}; return {ok:true,text:async()=>JSON.stringify({choices:[{message:msg}]})}; });
 const brain=new Brain({apiKey:'test',baseUrl:'https://test.invalid',role:{build:()=>''},memory:{render:()=>''},dataDir:process.env.TMPDIR});
 const result=await brain.reply({key:'group:fish-test-3',userId:'42',text:'你好',record:false});
 assert.equal(result.text,'好呀。'); assert.equal(result.voiceB64,''); assert.match(JSON.stringify(bodies[1].messages),/未通过风格检查/);
});
