import test from 'node:test';
import assert from 'node:assert/strict';
import {handleTurn} from '../src/index.js';
import {Humanizer} from '../src/humanize.js';
import {prepareConciseReply} from '../src/chat-concise-delivery.js';

const draft='古代的人喝的东西其实挺丰富，除了白水，也有用谷物和植物制成的饮品。不同地方和时代的做法不一样，味道也各有区别。人们会根据季节、材料和习惯来选择。\n\n有些饮品需要先加工原料，再经过浸泡或煮制；也有些适合日常饮用。各地的材料不同，喝法也会有所差异。';

test('真实入口在发送前精简约百字双段回答，不重复调用生成或工具',async()=>{
 const calls=[]; const sent=[];
 const brain={reply:async()=>{calls.push('reply');return {text:draft}},rewriteConciseDraft:async d=>{calls.push('rewrite');assert.equal(d,draft);return '古人也喝谷物和植物制成的饮品，做法因时代和地方而异。'},verifyConciseDraft:async()=>{calls.push('verify');return true}};
 const memory={renderPerson:()=>'',renderRecent:()=>'',sessionTurns:()=>[],remember:()=>{},logTurn:()=>{},touch:()=>{}};
 const item={key:'private:342',isGroup:false,userId:'42',name:'fixture',text:'古人喝什么？',images:[],raw:{},isAtMe:true,isPoke:false,replyTo:null,messageId:'fixture',time:Date.now()};
 await handleTurn({bot:{send:async(_k,m)=>{sent.push(m);return {ok:true}},setTyping:async()=>{}},brain,human:new Humanizer({enabled:false}),memory,waker:{wake:()=>{}}},[item],{ownerIds:[],dataDir:process.env.TMPDIR});
 assert.deepEqual(calls,['reply','rewrite','verify']); assert.deepEqual(sent,['古人也喝谷物和植物制成的饮品，做法因时代和地方而异。']);
});

test('短答直接通过，超长技术代码精简失败时静默',async()=>{
 let calls=0; const rewrite=async()=>{calls++;throw Error('unexpected')};
 assert.deepEqual((await prepareConciseReply('好呀。',rewrite)).parts,['好呀。']);
 const code='```js\n'+ 'const x = 1;\n'.repeat(15)+'```';
 const result=await prepareConciseReply(code,rewrite);
 assert.deepEqual(result.parts,[]); assert.equal(result.failed,true); assert.equal(calls,5);
});
