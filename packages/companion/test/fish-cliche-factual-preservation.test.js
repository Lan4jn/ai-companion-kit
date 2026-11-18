import test from 'node:test';
import assert from 'node:assert/strict';
import { Brain } from '../src/brain.js';

const makeBrain=()=>new Brain({apiKey:'fixture',baseUrl:'https://fixture.invalid',model:'fixture'});
const response=content=>({ok:true,text:async()=>JSON.stringify({choices:[{finish_reason:'stop',message:{content}}]})});
test('fact, stance and conditions remain unchanged in direct chats', async t => {
 const examples = ['这条我认。我做错了，但你的结论不成立。', '我记下了，青霉素过敏，急救时别用。', '这条我认。只有审核通过才可以执行。'];
 let i=0; t.mock.method(globalThis,'fetch',async()=>response(examples[i++]));
 for (const expected of examples) {
  const result=await makeBrain().reply({key:`private:semantic-${i}`,userId:'42',text:'解释',history:[],record:false,addressed:true});
  assert.equal(result.text,expected);
 }
 assert.equal(i,examples.length);
});

test('factual long replies keep all facts and code across QQ and WeChat without extra requests',async t=>{
 const original='这条我认。价格是 500 元（含税），保修三年。\n```js\nconsole.log(42)\n```';let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return response(original)});
 for(const key of ['private:fixture','group:fixture','wx:private:fixture','wx:group:fixture']){
  const result=await makeBrain().reply({key,userId:'42',text:'请详细回答',history:[],record:false,addressed:true});
  assert.equal(result.text, original);
 }
 assert.equal(calls,4);
});
