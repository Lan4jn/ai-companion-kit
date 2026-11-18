import test from 'node:test';
import assert from 'node:assert/strict';
import {register} from 'node:module';
import {handleTurn} from '../src/index.js';
import {OneBot} from '../src/transport-onebot.js';
import {Brain} from '../src/brain.js';
import {Humanizer} from '../src/humanize.js';
register('./memory-brain-fake-ws-loader.js',import.meta.url);

test('synthetic OneBot through real handleTurn and Brain, no network',async t=>{
 let received;const got=new Promise(r=>received=r);const bot=new OneBot({wsUrl:'ws://fixture',onMessage:received});bot.api=async()=>({ok:false});bot.getMyGroupCard=async()=>'';
 t.after(()=>bot.close());while(!bot.ws)await new Promise(r=>setTimeout(r,5));
 bot.ws.emit('open');
 bot.ws.emit('message',JSON.stringify({post_type:'message',message_type:'private',user_id:42,self_id:99,message_id:1,message:[{type:'text',data:{text:'你好呀'}}],sender:{nickname:'fixture'}}));
 const item=await got;const sent=[];bot.send=async(_k,m)=>{sent.push(m);return {ok:true,data:{message_id:123}}};bot.setTyping=async()=>{};bot.sendVoice=async()=>{throw Error('unexpected voice')};
 const requests=[];t.mock.method(globalThis,'fetch',async(_u,o)=>{requests.push(JSON.parse(o.body));const x={choices:[{finish_reason:'stop',message:{content:requests.length===1?'这条我认。':'好呀。'}}]};return {ok:true,text:async()=>JSON.stringify(x),json:async()=>x}});
 const memory={dir:process.env.TMPDIR,renderPerson:()=>'',renderRecent:()=>'',sessionTurns:()=>[],remember:()=>{},logTurn:()=>{},touch:()=>{}};
 const brain=new Brain({apiKey:'fixture',baseUrl:'https://fixture.invalid/v1',model:'fixture',memory,role:{build:()=>''},dataDir:process.env.TMPDIR});
 const human=new Humanizer({enabled:false});
 await handleTurn({bot,brain,human,memory,waker:{wake:()=>{}}},[item],{ownerIds:[],dataDir:process.env.TMPDIR});
 assert.deepEqual(sent,[]);assert.equal(requests.length,2);
});
