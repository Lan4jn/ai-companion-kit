import test from 'node:test';
import assert from 'node:assert/strict';
import {WebSocketServer} from 'ws';
import {OneBot} from '../src/transport-onebot.js';
import {handleTurn} from '../src/index.js';
import {Brain} from '../src/brain.js';
import {Humanizer} from '../src/humanize.js';

const image=(url,file='other')=>({type:'image',data:{url,file}});
const text=s=>({type:'text',data:{text:s}});
test('synthetic OneBot quotes preserve scope, CQ media and model entry',async t=>{
 const server=new WebSocketServer({host:'127.0.0.1',port:0}); await new Promise(r=>server.once('listening',r)); let peer; const ready=new Promise(r=>server.once('connection',s=>{peer=s;r()}));
 let receive, response; const bot=new OneBot({wsUrl:`ws://127.0.0.1:${server.address().port}`,dataDir:process.env.TMPDIR,onMessage:m=>receive(m)});bot.getMyGroupCard=async()=>'';bot.api=async action=>action==='get_msg'?response:{ok:true,data:{status:'ok',retcode:0,data:{}}}; await ready;t.after(()=>{bot.close();server.close()});
 const send=async(message,opts={})=>{const p=new Promise(r=>receive=r);peer.send(JSON.stringify({post_type:'message',message_type:'group',self_id:99,group_id:10,user_id:2,message_id:100,message,...opts}));return p};
 const valid={message_id:5,message_type:'group',group_id:10,sender:{user_id:3,nickname:'fixture'},message:[text('quoted'),image('https://fixture.invalid/a?x=1&y=2'),image('https://fixture.invalid/b')]};
 const ok=ref=>({ok:true,data:{status:'ok',retcode:0,data:ref}});
 response=ok(valid);let m=await send('[CQ:reply,id=5]看看'); assert.match(m.text,/quoted/);assert.equal(m.replyTo,'5');assert.equal(m.images.length,2);
 response=ok({...valid,message:'quoted[CQ:image,file=ignored,url=https://fixture.invalid/a?x=1&amp;y=2][CQ:image,file=ignored,url=https://fixture.invalid/b]'});m=await send([{type:'reply',data:{id:'5'}},text('看看'),image('https://fixture.invalid/a?x=1&y=2')]); assert.deepEqual(m.images,['https://fixture.invalid/a?x=1&y=2','https://fixture.invalid/b']);
 let captured; await handleTurn({bot,brain:{reply:async p=>{captured=p;return {text:''}}},memory:{dir:process.env.TMPDIR},human:{},waker:{}},[m],{ownerIds:[],dataDir:process.env.TMPDIR});assert.deepEqual(captured.images,m.images);assert.match(captured.text,/quoted/);
 const requests=[]; t.mock.method(globalThis,'fetch',async(url,opts)=>{if(String(url).startsWith('https://fixture.invalid/')) return {ok:true,headers:{get:()=> 'image/png'},arrayBuffer:async()=>Buffer.from(String(url).endsWith('/b')?'b':'a')}; const p=JSON.parse(opts.body);requests.push(p);return {ok:true,text:async()=>JSON.stringify({choices:[{message:{content:'收到'}}]})};});
 const memory={dir:process.env.TMPDIR,renderPerson:()=>'',renderRecent:()=>'',sessionTurns:()=>[],remember:()=>{},logTurn:()=>{},touch:()=>{}};
 const brain=new Brain({apiKey:'fixture',baseUrl:'https://model.invalid/v1',model:'fixture',mainVision:true,memory,dataDir:process.env.TMPDIR,role:{system:()=> 'fixture',build:()=> 'fixture',render:()=> 'fixture'}}); const sent=[];bot.send=async(k,v)=>{sent.push(v);return {ok:true}};bot.setTyping=async()=>{};
 await handleTurn({bot,brain,memory,human:new Humanizer({enabled:false}),waker:{wake(){}}},[m],{ownerIds:[],dataDir:process.env.TMPDIR});
 const payload=JSON.stringify(requests);assert.match(payload,/quoted/);assert.match(payload,/data:image\/png;base64,YQ==/);assert.match(payload,/data:image\/png;base64,Yg==/);assert.ok(sent.length<=3);assert.ok([...sent.join('')].length<=50);
 for(const ref of [{...valid,group_id:20},{...valid,group_id:undefined},{...valid,message_id:6},{...valid,message_type:'private'}]){response=ok(ref);m=await send([{type:'reply',data:{id:'5'}},text('看看')]);assert.doesNotMatch(m.text,/quoted/);assert.deepEqual(m.images,[])}
 response={ok:true,data:{status:'failed',retcode:1,data:valid}};m=await send([{type:'reply',data:{id:'5'}},text('看看')]);assert.doesNotMatch(m.text,/quoted/);
 response=ok({message_id:5,message_type:'private',self_id:99,user_id:2,sender:{user_id:2,nickname:'fixture'},message:[text('private quote')]});m=await send([{type:'reply',data:{id:'5'}},text('看看')],{message_type:'private',group_id:undefined});assert.match(m.text,/private quote/);
 response=ok({message_id:5,message_type:'private',self_id:99,user_id:3,sender:{user_id:3},message:[text('foreign')]});m=await send([{type:'reply',data:{id:'5'}},text('看看')],{message_type:'private',group_id:undefined});assert.doesNotMatch(m.text,/foreign/);
 response=ok({...valid,message:[text('escaped'),image('https://fixture.invalid/c'),image('https://fixture.invalid/c')]});m=await send('[CQ:reply,id=5]hi');assert.deepEqual(m.images,['https://fixture.invalid/c']);
 response=ok({...valid,message:'[CQ:image,file=only&#44;file]'});m=await send('[CQ:reply,id=5]hi');assert.deepEqual(m.images,['only,file']);
 response=ok({...valid,group_id:10});m=await send([{type:'reply',data:{id:'5'}},text('missing scope')],{group_id:undefined});assert.doesNotMatch(m.text,/quoted/);assert.deepEqual(m.images,[]);
 let calls=0;bot.api=async action=>{if(action==='get_msg'){calls++;throw Error('SECRET SHOULD NOT LOG')}return {ok:true,data:{}}}; const logs=[];t.mock.method(console,'warn',(...args)=>logs.push(args.join(' ')));m=await send([{type:'reply',data:{id:'5'}},text('hi')]);assert.equal(calls,1);assert.ok(logs.includes('[onebot] quote stage=get_msg_error'));assert.ok(!logs.join('').includes('SECRET'));assert.doesNotMatch(m.text,/quoted/);
 await send([text('ordinary')]);assert.equal(calls,1);
});
