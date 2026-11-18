import test from 'node:test';
import assert from 'node:assert/strict';
import { Brain } from '../src/brain.js';
import { createTiebaScheduler } from '../src/tieba-scheduler.js';

test('diagnostic model response with unexecuted tool calls cannot masquerade as a browse decision', async t => {
  const old = globalThis.fetch; t.after(() => { globalThis.fetch = old; });
  globalThis.fetch = async () => ({ok:true,json:async()=>({choices:[{finish_reason:'tool_calls',message:{content:'{"browse":true}',tool_calls:[{type:'function',function:{name:'do_something',arguments:'{}'}}]}}]})});
  const brain = new Brain({apiKey:'fake',baseUrl:'https://example.invalid',model:'fake',memory:{}});
  let reads=0;
  const scheduler = createTiebaScheduler({enabled:true,brain,reader:{run:async()=>{reads++;return {status:'completed'};}}});
  assert.deepEqual(await scheduler.tick(),{status:'model_failed',error:{category:'response_format'}});
  assert.equal(reads,0);
});
