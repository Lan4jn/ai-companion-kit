import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {postDanmaku, draftDanmaku} from '../src/bili-grow.js';
import {createFanqiePublicationAdapter} from '../src/fanqie-social-publication.js';
import {runFanqieSocial} from '../src/fanqie-social.js';
import {submitDouyinComment, sendDouyinCommentOnce} from '../src/douyin-living.js';
const text=n=>'景'.repeat(n), ownerIds=['123456789'];
test('弹幕出口50原样发送，51拦截；生成不截断',async()=>{
 const old=globalThis.fetch; const sent=[];
 globalThis.fetch=async (_url,req)=>{sent.push(new URLSearchParams(req.body).get('msg'));return {json:async()=>({code:0})}};
 try {
  assert.equal((await postDanmaku({msg:text(50),ownerIds})).ok,true);
  assert.equal((await postDanmaku({msg:text(51),ownerIds})).code,'reply_too_long');
  assert.deepEqual(sent,[text(50)]);
  for(const n of [50,51]) assert.equal(await draftDanmaku({reply:async()=>({text:text(n)})},{},''),n===50?text(n):null);
 } finally {globalThis.fetch=old}
});
test('番茄适配器50一次发送、未知结果不可重发；51不触碰设备',async()=>{
 for(const n of [50,51]){
  let calls=0, typed=''; const target={bookId:'b',threadId:'t'};
  const io={observe:async()=>({target,accountId:'a',authenticated:true,composer:true,text:typed,submitEnabled:true,baselineComplete:true,visibleCommentIds:[]}),fill:async t=>{typed=t},submit:async()=>{calls++;return {ok:false}},readBack:async()=>({})};
  const adapter=createFanqiePublicationAdapter({serial:'dedicated',configuredSerial:'dedicated',ownerIds,accountId:'a',io});
  const request={target,choice:{action:'comment',text:text(n)}};
  const result=await adapter.submit(request);
  assert.equal(result.reason,n===50?'submit-unknown':'reply-too-long');
  assert.equal(calls,n===50?1:0); assert.equal(typed,n===50?text(n):'');
  assert.equal((await adapter.submit(request)).reason,'attempt-already-used'); assert.equal(calls,n===50?1:0);
 }
});
test('番茄社交流程评论和回复的50/51边界，保留阅读选择',async()=>{
 for(const action of ['comment','reply']) for(const n of [50,51]){
  let submitted=0;
  const reading={text:'阅读',source:'s',fingerprint:'f',progress:'1'};
  const driver={checkReading:async()=>true,openComments:async()=>({ok:true}),readComments:async()=>[{id:'id',text:'评论'}],checkContext:async()=>true,submit:async r=>{submitted++;assert.equal(r.choice.text,text(50));return {ok:false}},verify:async()=>({ok:false})};
  const result=await runFanqieSocial({reading,driver,ownerIds,decide:async()=>({action,text:text(n),targetId:'id'})});
  assert.equal(result.reason,n===50?'submit-failed':'reply-too-long'); assert.equal(submitted,n===50?1:0);
 }
});
test('抖音网页出口50/51和未知结果不重发',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'short-answer-'));let clicks=0,typed='';
 const page={evaluate:async()=>true,waitForTimeout:async()=>{},keyboard:{type:async t=>{typed=t}},locator:()=>({first:()=>({count:async()=>1,click:async()=>{clicks++;throw Error('unknown')}})})};
 try {
  let calls=0;
  assert.equal(await submitDouyinComment(text(51),ownerIds,async()=>{calls++}),false); assert.equal(calls,0);
  const result=await submitDouyinComment(text(50),ownerIds,async()=>{calls++;return 'ok'}); assert.equal(result,'ok'); assert.equal(calls,1);
  assert.equal((await sendDouyinCommentOnce(page,{text:text(51),workId:'1',dataDir:dir})).status,'failed'); assert.equal(clicks,0);
  assert.equal((await sendDouyinCommentOnce(page,{text:text(50),workId:'1',dataDir:dir})).status,'unknown'); assert.equal(typed,text(50)); assert.equal(clicks,1);
  assert.equal((await sendDouyinCommentOnce(page,{text:text(50),workId:'1',dataDir:dir})).status,'blocked'); assert.equal(clicks,1);
 } finally {fs.rmSync(dir,{recursive:true,force:true})}
});
