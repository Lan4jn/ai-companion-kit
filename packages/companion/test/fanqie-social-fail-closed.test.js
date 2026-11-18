import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runFanqieSocial} from '../src/fanqie-social.js';

const reading={text:'真实页面',source:'OCR',fingerprint:'p',progress:{chapter:'一',page:1,total:5}};

test('书评阅读驱动没有发布能力时明确拒绝，不抛异常',async()=>{
 const driver={checkReading:async()=>true,openComments:async()=>({ok:true}),readComments:async()=>[]};
 const result=await runFanqieSocial({reading,driver,ownerIds:['123456789'],decide:async()=>({action:'comment',text:'感想'})});
 assert.equal(result.reason,'publication-unavailable');
});

test('同一目标ID对应多条书评时拒绝点赞',async()=>{
 let submitted=0;
 const driver={checkReading:async()=>true,openComments:async()=>({ok:true}),readComments:async()=>[{id:'a',text:'甲'},{id:'a',text:'乙'}],checkContext:async()=>true,submit:async()=>{submitted++;return {ok:true}},verify:async()=>({ok:true,reference:'like'})};
 const result=await runFanqieSocial({reading,driver,decide:async()=>({action:'like',targetId:'a'})});
 assert.equal(result.reason,'target-ambiguous');assert.equal(submitted,0);
});
