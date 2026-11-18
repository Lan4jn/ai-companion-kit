import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareConciseReply } from '../src/chat-concise-delivery.js';
import { Brain } from '../src/brain.js';

const draft = '这家店的营业时间是每天早上九点。\n\n晚上九点关门。\n\n周末也营业。\n\n建议提前打电话确认。';
test('semantic compression is accepted only after independent verification', async () => {
  let rewrites=0, checks=0;
  const result=await prepareConciseReply(draft, async()=>{rewrites++; return '这家店每天早九点到晚九点营业，周末也开门。\n\n建议提前打电话确认。';}, async (original,candidate)=>{checks++; assert.equal(original,draft); assert.ok(candidate.includes('周末')); return true;});
  assert.equal(result.rewritten,true); assert.equal(result.parts.length,2); assert.equal(rewrites,1); assert.equal(checks,1);
});
test('unverified or altered numeric content is never delivered', async () => {
  let checks=0;
  const result=await prepareConciseReply('每天2次。\n\n餐后。\n\n过敏停用。\n\n问医生。',async()=> '每天3次，餐后服用；过敏停用，问医生。',async()=>{checks++;return true;});
  assert.equal(result.failed,true); assert.equal(checks,0);
});
test('verifier rejection fails closed within bounded attempts', async () => {
  let rewrites=0, checks=0;
  const result=await prepareConciseReply(draft,async()=>{rewrites++;return '每天营业，请提前确认。';},async()=>{checks++;return false;});
  assert.equal(result.failed,true); assert.equal(rewrites,5); assert.equal(checks,5);
});
test('review API is isolated, no tools, and fails closed on tool calls', async t => {
 const requests=[]; const brain=new Brain({apiKey:'fixture',model:'fixture',baseUrl:'https://example.invalid',role:{},memory:{}});
 t.mock.method(globalThis,'fetch',async (_url,opts)=>{requests.push(JSON.parse(opts.body));return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:'PASS',tool_calls:[{id:'x'}]}}]})};});
 await assert.rejects(brain.verifyConciseDraft(draft,'简短回复'));
 assert.equal(requests[0].tool_choice,'none'); assert.equal(requests[0].tools,undefined); assert.equal(requests[0].stream,false);
 assert.equal(requests[0].messages.length,2); assert.ok(!JSON.stringify(requests[0]).includes('fixture-private-history'));
});
