import test from 'node:test';
import assert from 'node:assert/strict';
import {handleTurn} from '../src/index.js';
import {Humanizer} from '../src/humanize.js';
import {prepareConciseReply} from '../src/chat-concise-delivery.js';
const long='古时候饮品有许多种，材料会随着地方和季节变化，人们也会根据习惯选用。'.repeat(5);
for (const key of ['private:342','group:42','wx:private:343']) test(`offline entry ${key}: long rewrite and no tool replay`,async()=>{
 const calls=[], sent=[]; let toolExecutions=0;
 const brain={reply:async()=>{calls.push('reply');toolExecutions++;return {text:long}},rewriteConciseDraft:async()=>{calls.push('rewrite');return '古时饮品种类不少，材料和选择因地方、季节及习惯而异。'},verifyConciseDraft:async()=>{calls.push('verify');return true}};
 const memory={renderPerson:()=>'',renderRecent:()=>'',sessionTurns:()=>[],remember:()=>{},logTurn:()=>{},touch:()=>{}};
 const isGroup=key.startsWith('group:');
 const item={key,isGroup,groupId:isGroup?'42':'',userId:'42',name:'fixture',text:'古人喝什么？',images:[],raw:{},isAtMe:true,isPoke:false,replyTo:null,messageId:'fixture',time:Date.now()};
 await handleTurn({bot:{send:async(k,m)=>{calls.push('send');sent.push(m);return {ok:true}},setTyping:async()=>{},getMyGroupCard:async()=>''},brain,human:new Humanizer({enabled:false}),memory,waker:{wake:()=>{}}},[item],{ownerIds:[],dataDir:process.env.TMPDIR});
 assert.deepEqual(calls,['reply','rewrite','verify','send']);assert.equal(toolExecutions,1);assert.deepEqual(sent,['古时饮品种类不少，材料和选择因地方、季节及习惯而异。']);
});
test('link and CQ do not hide ordinary long prose',async()=>{for(const p of ['https://example.test/','[CQ:face,id=123]']){let n=0;await prepareConciseReply(p+long,async()=>{n++;throw Error('offline')});assert.equal(n,5);}});
