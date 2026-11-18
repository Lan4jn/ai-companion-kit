import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runFanqieSocial,decideFanqieSocial} from '../src/fanqie-social.js';

const reading={text:'他走进了空荡荡的旧屋',source:'OCR',fingerprint:'page1',progress:{chapter:'第一章',page:1,total:20}};
test('决策提示明确允许跳过和只看，不强迫每页互动',async()=>{
 let request;
 const result=await decideFanqieSocial({complete:async r=>{request=r;return '{"action":"skip"}';}},{reading,comments:null});
 assert.equal(result.action,'skip');
 assert.match(request.system,/跳过/);assert.match(request.system,/只看/);assert.match(request.system,/不要每页/);
});
test('跳过是正常决定，不打开评论也不发布',async()=>{
 let actions=0;
 const r=await runFanqieSocial({reading,decide:async()=>({action:'skip'}),driver:{openComments:async()=>actions++}});
 assert.equal(r.reason,'declined');assert.equal(actions,0);
});
test('选择只看评论时读取真实评论，但不发布',async()=>{
 let submitted=0;
 const r=await runFanqieSocial({reading,decide:async()=>({action:'view'}),driver:{checkReading:async()=>true,openComments:async()=>({ok:true}),readComments:async()=>[{id:'c1',text:'有点紧张'}],submit:async()=>submitted++}});
 assert.deepEqual(r.comments,[{id:'c1',text:'有点紧张'}]);assert.equal(submitted,0);
});
test('发送评论必须配置主人ID并执行外发隐私检查',async()=>{
 let sent=0;const driver={checkReading:async()=>true,openComments:async()=>({ok:true}),readComments:async()=>[],checkContext:async()=>true,submit:async()=>{sent++;return {ok:true}},verify:async()=>({ok:true,reference:'x'})};
 const run=(text,ownerIds)=>runFanqieSocial({reading,ownerIds,decide:async()=>({action:'comment',text}),driver});
 assert.equal((await run('普通评论',[])).reason,'privacy-unconfigured');
 assert.equal((await run('号码是 123456789',['123456789'])).reason,'privacy-blocked');
 assert.equal((await run('[CQ:at,qq=123]',['123456789'])).reason,'privacy-blocked');
 assert.equal(sent,0);
});
test('评论发布缺少独立证据时不记录成功',async()=>{
 let saved=0;
 const driver={checkReading:async()=>true,openComments:async()=>({ok:true}),readComments:async()=>[],checkContext:async()=>true,submit:async()=>({ok:true}),verify:async()=>({ok:false})};
 const r=await runFanqieSocial({reading,ownerIds:['123456789'],decide:async()=>({action:'comment',text:'这段有点紧张'}),driver,save:async()=>saved++});
 assert.equal(r.reason,'unverified');assert.equal(saved,0);
});
test('未读到内容、阅读位置改变或目标不在评论中时绝不提交',async()=>{
 let submitted=0;const driver={checkReading:async()=>false,openComments:async()=>({ok:true}),readComments:async()=>[],submit:async()=>submitted++};
 assert.equal((await runFanqieSocial({reading:null,decide:async()=>{throw Error('must not decide')},driver})).reason,'no-reading');
 assert.equal((await runFanqieSocial({reading,decide:async()=>({action:'view'}),driver})).reason,'reading-changed');
 driver.checkReading=async()=>true;
 assert.equal((await runFanqieSocial({reading,decide:async()=>({action:'like',targetId:'unknown'}),driver})).reason,'target-unobserved');
 assert.equal(submitted,0);
});
test('核验通过才保存记录',async()=>{
 let saved;const driver={checkReading:async()=>true,openComments:async()=>({ok:true}),readComments:async()=>[{id:'a',text:'评论'}],checkContext:async()=>true,submit:async()=>({ok:true}),verify:async()=>({ok:true,reference:'observed-like'})};
 const r=await runFanqieSocial({reading,decide:async()=>({action:'like',targetId:'a'}),driver,save:async x=>saved=x});
 assert.equal(r.reason,'verified');assert.equal(saved.evidence,'observed-like');
});
