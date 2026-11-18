import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadingScheduler } from '../src/fanqie-scheduler.js';

test('stopping scheduled loop while willingness is pending prevents device work', {timeout: 2000}, async t => {
 // The scheduler deliberately unreferences its timer; the test must keep Node alive.
 const keepAlive = setTimeout(() => {}, 2000);
 t.after(() => clearTimeout(keepAlive));
 let release, began; const started = new Promise(r => began = r); let runs = 0;
 const s = createReadingScheduler({intervalMs:1,want:async()=>{began();return await new Promise(r=>release=r)},run:async()=>{runs++;return {ok:true}}});
 s.start(); await started; const stopped = s.stop(); release(true);
 await stopped; assert.equal(runs,0);
});
