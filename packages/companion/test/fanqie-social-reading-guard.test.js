import test from 'node:test';
import assert from 'node:assert/strict';
import { createFanqieReadingGuard } from '../src/fanqie-social-reading-guard.js';

test('accepts only an unchanged pinned reader observation', async () => {
 const expected={text:'内容',source:'OCR',fingerprint:'abc',progress:{chapter:'第1章',page:1,total:12}};
 let calls=0;
 const guard=createFanqieReadingGuard({serial:'dedicated',configuredSerial:'dedicated',progress:async()=>{calls++;return expected.progress},capture:async()=>({...expected})});
 assert.equal(await guard(expected),true);
 assert.equal(calls,2);
});

test('fails closed on a mismatched serial, changed page or device failure', async () => {
 const reading={text:'内容',source:'OCR',fingerprint:'abc',progress:{chapter:'第1章',page:1,total:12}};
 const make=(options={})=>createFanqieReadingGuard({serial:'one',configuredSerial:'one',progress:async()=>reading.progress,capture:async()=>reading,...options});
 assert.equal(await make({configuredSerial:'other'})(reading),false);
 assert.equal(await make({capture:async()=>({...reading,fingerprint:'changed'})})(reading),false);
 let count=0;
 assert.equal(await make({progress:async()=>++count===1 ? reading.progress : {...reading.progress,page:2}})(reading),false);
 assert.equal(await make({progress:async()=>{throw Error('offline')}})(reading),false);
});
