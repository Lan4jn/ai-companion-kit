import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareConciseReply } from '../src/chat-concise-delivery.js';
import { Brain } from '../src/brain.js';

const draft = '第一点。\n\n第二点。\n\n第三点。\n\n第四点。';
test('four paragraphs invoke model before producing at most three faithful bubbles', async () => {
  let calls = 0;
  const result = await prepareConciseReply(draft, async () => { calls++; return '第一点。\n第二点。\n\n第三点。\n\n第四点。'; }, async () => true);
  assert.equal(calls, 1);
  assert.deepEqual(result.parts, ['第一点。\n第二点。', '第三点。', '第四点。']);
});
test('ordinary prose triggers reconsideration above 50 Unicode code points', async () => {
  for (const [length, expected] of [[50, 0], [51, 1]]) {
    let calls = 0;
    await prepareConciseReply('🐟'.repeat(length), async () => { calls++; return '🐟'; }, async () => true);
    assert.equal(calls, expected);
  }
});

test('reject altered facts, errors, excessive length and technical modifications', async () => {
  for (const input of [draft, '药物每天2次。\n\n餐后服用。\n\n过敏停用。\n\n咨询医生。', '```js\nx()\n```\n\na\n\nb\n\nc']) {
    let calls=0; const result=await prepareConciseReply(input,async()=>{calls++; return '好的';});
    assert.equal(calls,5); assert.equal(result.failed,true); assert.deepEqual(result.parts,[]);
  }
});
test('rewrite request is non-streaming and has no tools, rejects tool calls', async t => {
  const brain=new Brain({apiKey:'fixture',baseUrl:'https://fixture.invalid',role:{},memory:{}});
  let body;
  t.mock.method(globalThis,'fetch',async (_url,opts)=>{body=JSON.parse(opts.body);return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:'x',tool_calls:[{id:'x'}]}}]})};});
  await assert.rejects(brain.rewriteConciseDraft(draft));
  assert.equal(body.tool_choice,'none'); assert.equal(body.stream,false); assert.equal(body.tools,undefined);
});
