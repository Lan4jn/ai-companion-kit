import test from 'node:test';
import assert from 'node:assert/strict';
import { runHongguoCycle } from '../src/hongguo-autonomous.js';
test('cycle invokes navigation after a real decision to watch', async () => {
 let calls=0;
 const result=await runHongguoCycle({permission:true,brain:{complete:async()=>'{"want":true}'},navigate:async()=>{calls++;return {status:'skipped'};}});
 assert.equal(calls,1);assert.equal(result.status,'skipped');
});
test('cycle never navigates after a decision to skip', async () => {
 let calls=0; const result=await runHongguoCycle({permission:true,brain:{complete:async()=>'{"want":false}'},navigate:async()=>{calls++;}});
 assert.equal(result.status,'skipped');assert.equal(calls,0);
});
