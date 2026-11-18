import test from 'node:test';
import assert from 'node:assert/strict';
import { createFanqieRunner } from '../src/fanqie-runner.js';
import { runReadingStep } from '../src/fanqie-autonomous.js';

test('observed book identity must not inherit another navigation book ID', async () => {
 let record;
 const run=createFanqieRunner({exclusive:async fn=>{await fn();return true},navigate:async()=>({ok:true,bookId:'book-A',bookTitle:'甲书'}),read:()=>runReadingStep({observe:async()=>({text:'正文',source:'OCR',fingerprint:'x',progress:{page:1,total:2},bookTitle:'乙书'}),understand:async()=>({interested:true,continueReading:false,summary:'正文',keywords:[]}),save:async r=>{record=r},turn:async()=>{throw Error('unexpected')}})});
 assert.equal((await run()).ok,true);
 assert.equal(record.bookTitle,'乙书');
 assert.equal(Object.hasOwn(record,'bookId'),false);
});
