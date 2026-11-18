import test from 'node:test';
import assert from 'node:assert/strict';
import {register} from 'node:module';
import {handleTurn} from '../src/index.js';
import {OneBot} from '../src/transport-onebot.js';
import {Brain} from '../src/brain.js';
import {Humanizer} from '../src/humanize.js';
register('./memory-brain-fake-ws-loader.js',import.meta.url);

test('synthetic OneBot actual entry sends rewritten reply exactly once',async t=>{
 let received;const got=new Promise(r=>received=r);const bot=new OneBot({wsUrl:'ws://fixture',onMessage:received});bot.api=async()=>({ok:false});bot.getMyGroupCard=async()=>'';
 t.after(()=>bot.close());while(!bot.ws)await new Promise(r=>setTimeout(r,5));
 bot.ws.emit('open');
 bot.ws.emit('message',JSON.stringify({post_type:'message',message_type:'private',user_id:42,self_id:99,message_id:1,message:[{type:'text',data:{text:'你好呀'}}],sender:{nickname:'fixture'}}));
 const item=await got;const sent=[];bot.send=async(_k,m)=>{sent.push(m);return {ok:true,data:{message_id:123}}};bot.setTyping=async()=>{};bot.sendVoice=async()=>{throw Error('unexpected voice')};
 const requests=[];t.mock.method(globalThis,'fetch',async(_u,o)=>{requests.push(JSON.parse(o.body));const x={choices:[{finish_reason:'stop',message:{content:requests.length===1?'这条我认。':'说得对。'}}]};return {ok:true,text:async()=>JSON.stringify(x)}});
 const memory={dir:process.env.TMPDIR,renderPerson:()=>'',renderRecent:()=>'',sessionTurns:()=>[],remember:()=>{},logTurn:()=>{},touch:()=>{}};
 const brain=new Brain({apiKey:'fixture',baseUrl:'https://example.invalid',model:'test',memory});
 const human=new Humanizer({enabled:false});
 await handleTurn({bot,brain,human,memory,waker:{wake:()=>{}}},[item],{ownerIds:[],dataDir:process.env.TMPDIR});
 assert.deepEqual(sent,['说得对。']);assert.equal(requests.length,2);assert.equal(requests[1].tools,undefined);
});

test('completed search tool executes once and rewrite cannot invoke a tool',async t=>{
 const requests=[];let searches=0;
 t.mock.method(globalThis,'fetch',async(_u,o)=>{requests.push(JSON.parse(o.body));const message=requests.length===1?{content:null,tool_calls:[{id:'s1',type:'function',function:{name:'web_search',arguments:JSON.stringify({query:'太阳系是什么？'})}}]}:requests.length===2?{content:'这话我认。'}:{content:'没错。',tool_calls:[{id:'attack',type:'function',function:{name:'web_search',arguments:'{}'}}]};return {ok:true,text:async()=>JSON.stringify({choices:[{finish_reason:'stop',message}]})}});
 const brain=new Brain({apiKey:'fixture',baseUrl:'https://example.invalid',model:'test',memory:{getHistory:()=>[],addMessage:()=>{},getSummary:()=>''}});
 brain.search=async()=>{searches++;return {success:true,text:'资料 https://example.invalid'}};
 const r=await brain.reply({key:'private:tool-count-fixture',userId:'42',text:'太阳系是什么？',history:[],record:false,addressed:true,trapProbe:true});
 assert.equal(searches,1);assert.equal(requests.length,3);assert.equal(requests[2].tools,undefined);assert.equal(r.reason,'fish_cliche');assert.match(r.text,/没能安全生成/);
});


test('synthetic WeChat private and group suppress failed rewrites',async t=>{
 let calls=0; t.mock.method(globalThis,'fetch',async()=>{calls++; if(calls%2===0) throw Error('fixture rewrite failure'); return {ok:true,text:async()=>JSON.stringify({choices:[{finish_reason:'stop',message:{content:'这条我认。'}}]})}});
 const memory={dir:process.env.TMPDIR,renderPerson:()=>'',renderRecent:()=>'',sessionTurns:()=>[],remember:()=>{},logTurn:()=>{},touch:()=>{}};
 const sent=[];const bot={send:async(k,m)=>{sent.push([k,m]);return {ok:true,data:{message_id:123}}},setTyping:async()=>{},getMyGroupCard:async()=>''};
 const human=new Humanizer({enabled:false});
 const brain=new Brain({apiKey:'fixture',baseUrl:'https://fixture.invalid/v1',model:'fixture',memory,llmFallbacks:[]});
 for(const [key,isGroup] of [['wx:private:fake-wx',false],['wx:group:fake-room',true]]) {
 const item={key,isGroup,groupId:isGroup?'fake-room':'',userId:'fake-wx',name:'fixture',text:'你好呀',images:[],raw:{},isAtMe:true,isPoke:false,replyTo:null,messageId:'fixture',time:Date.now()};
 await handleTurn({bot,brain,human,memory,waker:{wake:()=>{}}},[item],{ownerIds:[],dataDir:process.env.TMPDIR});
 }
 assert.deepEqual(sent,[]);assert.equal(calls,4);
});
