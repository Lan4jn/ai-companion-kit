import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createFanqiePublicationAdapter} from '../src/fanqie-social-publication.js';

test('没有已验证账号及目标证据时拒绝输入与发表',async()=>{
 const calls=[];
 const driver=createFanqiePublicationAdapter({serial:'dedicated',configuredSerial:'dedicated',ownerIds:['123456789'],run:async (...a)=>{calls.push(a);return {stdout:''}}});
 const result=await driver.submit({choice:{action:'comment',text:'这段写得真好'}});
 assert.equal(result.ok,false); assert.equal(calls.length,0);
});

const target={bookId:'book-1',threadId:'thread-1'};
const request={target,choice:{action:'comment',text:'这段很动人'}};
function fixture(overrides={}) {
 const calls=[];
 const state={target:{...target},accountId:'account-1',authenticated:true,composer:true,text:'',submitEnabled:true,baselineComplete:true,visibleCommentIds:['old']};
 const io={
  observe:async()=>{calls.push('observe');return structuredClone(state)},
  fill:async text=>{calls.push('fill');state.text=text},
  submit:async()=>{calls.push('submit');return {ok:true}},
  readBack:async()=>{calls.push('readBack');return {target:{...target},accountId:'account-1',comments:[{id:'new',authorId:'account-1',text:request.choice.text}]}},
  ...overrides
 };
 return {calls,state,driver:createFanqiePublicationAdapter({serial:'dedicated',configuredSerial:'dedicated',ownerIds:['123456789'],accountId:'account-1',io})};
}
test('注入协议完成一次提交并独立读取新评论才确认',async()=>{
 const {driver,calls}=fixture();
 const result=await driver.submit(request);
 assert.equal(result.ok,true);assert.equal(result.reference,'new');
 assert.equal(calls.filter(x=>x==='submit').length,1);
 assert.equal(calls.filter(x=>x==='readBack').length,1);
 assert.equal((await driver.verify(request)).reference,'new');
 assert.equal((await driver.submit(request)).ok,false);
 assert.equal(calls.filter(x=>x==='submit').length,1);
});

test('基线不完整或输入框已有草稿时不输入',async()=>{
 for(const change of [{baselineComplete:false},{text:'已有草稿'}]){
  const {driver,state,calls}=fixture();Object.assign(state,change);
  assert.equal((await driver.submit(request)).ok,false);assert.equal(calls.includes('fill'),false);
 }
});

test('账号、目标或复核文本变化时不提交',async()=>{
 for(const mutate of [s=>s.authenticated=false,s=>s.accountId='other',s=>s.target.threadId='other']){
  const {driver,state,calls}=fixture();mutate(state);assert.equal((await driver.submit(request)).ok,false);assert.equal(calls.includes('fill'),false);assert.equal(calls.includes('submit'),false);
 }
 const f=fixture({fill:async()=>{f.state.text='被替换的文本'}});
 assert.equal((await f.driver.submit(request)).ok,false);assert.equal(f.calls.includes('submit'),false);
});
test('隐私内容被拒绝且不触碰设备',async()=>{
 const {driver,calls}=fixture();
 assert.equal((await driver.submit({...request,choice:{action:'comment',text:'号码 123456789'}})).reason,'privacy-blocked');
 assert.deepEqual(calls,[]);
});
test('提交异常或回读旧评论绝不成功且不能重试',async()=>{
 for(const io of [
  {submit:async()=>{throw Error('unknown')}},
  {readBack:async()=>({target,accountId:'account-1',comments:[{id:'old',authorId:'account-1',text:request.choice.text}]})}
 ]){
  const {driver}=fixture(io);
  assert.equal((await driver.submit(request)).ok,false);
  assert.equal((await driver.verify(request)).ok,false);
  assert.equal((await driver.submit(request)).reason,'attempt-already-used');
 }
});
test('并发调用只允许一个提交',async()=>{
 const {driver,calls}=fixture();
 const results=await Promise.all([driver.submit(request),driver.submit(request)]);
 assert.equal(results.filter(r=>r.ok).length,1);
 assert.equal(calls.filter(x=>x==='submit').length,1);
});
