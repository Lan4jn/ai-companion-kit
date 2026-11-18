import test from 'node:test';
import assert from 'node:assert/strict';
import {runFanqieSocial, decideFanqieSocial} from '../src/fanqie-social.js';
import {createFanqiePublicationAdapter} from '../src/fanqie-social-publication.js';

test('fanqie social blocks canned comment and reply before submit', async () => {
 for (const action of ['comment','reply']) {
  let submitted=0;
  const driver={checkReading:async()=>true,openComments:async()=>({ok:true}),readComments:async()=>[{id:'1',text:'可见'}],checkContext:async()=>true,submit:async()=>{submitted++;return {ok:true}},verify:async()=>({ok:true,reference:'1'})};
  const result=await runFanqieSocial({reading:{text:'阅读',source:'s',fingerprint:'f',progress:'p'},decide:async()=>({action,text:'这条我认',targetId:'1'}),driver,ownerIds:['12345']});
  assert.equal(result.reason,'public-comment-cliche'); assert.equal(submitted,0);
 }
});
test('direct fanqie adapter blocks before any IO', async()=>{
 let calls=0; const io=Object.fromEntries(['observe','fill','submit','readBack'].map(k=>[k,async()=>{calls++}]));
 const adapter=createFanqiePublicationAdapter({serial:'mock',configuredSerial:'mock',ownerIds:['12345'],accountId:'test',io});
 const result=await adapter.submit({target:{bookId:'b',threadId:'t'},choice:{action:'comment',text:'我接住了'}});
 assert.equal(result.reason,'public-comment-cliche'); assert.equal(calls,0);
});
test('generation receives public style guidance',async()=>{
 let system; await decideFanqieSocial({complete:async x=>{system=x.system;return '{"action":"skip"}'}},{reading:{},comments:[]});
 assert.match(system,/不要套用空洞/);
});
