import test from 'node:test';
import assert from 'node:assert/strict';
import { runHongguoCycle } from '../src/hongguo-autonomous.js';

test('reasoning models receive enough decision budget to return a JSON decision', async () => {
 const brain = { complete: async ({max_tokens}) => max_tokens >= 500 ? '{"want":false}' : '' };
 const result=await runHongguoCycle({permission:true,brain});
 assert.equal(result.status,'skipped');
});
