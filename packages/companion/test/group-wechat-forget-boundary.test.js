import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {initGroupBridge, readGroupChat} from '../src/group-bridge.js';
import {WeChatTransport} from '../src/transport-wechat.js';
import {handleTurn} from '../src/index.js';
import {Brain} from '../src/brain.js';
import {Humanizer} from '../src/humanize.js';

test('group bridge must not expose unfiltered forgotten messages',async()=>{
 const bot={groupMembers:new Map([['1',[]]]),api:async()=>({data:{messages:[{message_id:7,raw_message:'FORGOTTEN_GROUP_SECRET',sender:{nickname:'fixture'}}]}})};
 initGroupBridge({bot,dataDir:process.env.TMPDIR,limits:{allowedGroups:['1']},historyFilter:async()=>[]});
 const result=await readGroupChat({groupId:'1'});
 assert.doesNotMatch(JSON.stringify(result),/FORGOTTEN_GROUP_SECRET/);
});

test('real WeChat webhook and Brain never recall unverified old turns with scoped barrier',async t=>{
 const probe=http.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
 const requests=[],tasks=[];
 t.mock.method(globalThis,'fetch',async(url,opts)=>{
  const s=String(url);
  if(s.endsWith('/api/GetSelfWXID'))return {ok:true,json:async()=>({code:1,data:{wx_id:'fixture-self'}})};
  if(s.endsWith('/api/SetMessageCallbackUrl')||s.endsWith('/api/SendTxt'))return {ok:true,json:async()=>({code:1})};
  requests.push(JSON.parse(opts.body));return {ok:true,text:async()=>JSON.stringify({choices:[{finish_reason:'stop',message:{content:'你好呀'}}]})};
 });
 const memory={dir:process.env.TMPDIR,renderPerson:()=>'',renderRecent:()=>'',sessionTurns:()=>[{text:'FORGOTTEN_WX_RECENT'}],recallTurns:()=>[{text:'FORGOTTEN_WX_OLD',reply:'old'}],remember:()=>{},logTurn:()=>{},touch:()=>{}};
 const brain=new Brain({apiKey:'fixture',baseUrl:'https://fixture.invalid',model:'fixture',role:{build:({situation})=>situation},memory});
 const wx=new WeChatTransport({callbackPort:port,onMessage:item=>tasks.push(handleTurn({bot:wx,brain,human:new Humanizer({enabled:false}),memory,waker:{wake:()=>{}}},[item],{ownerIds:[],dataDir:process.env.TMPDIR,memoryBrain:{enabled:true}}))});
 await wx.start(); await once(wx.server,'listening');t.after(()=>new Promise(r=>wx.server.close(r)));
 await new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port,method:'POST',path:'/wechat/callback'},res=>{res.resume();res.on('end',resolve)});req.on('error',reject);req.end(JSON.stringify({data:{wx_id:'fixture-user',content:'你好',message_id:'1'}}));});
 await tasks[0]; assert.ok(requests.length); assert.doesNotMatch(JSON.stringify(requests),/FORGOTTEN_WX_/);
 await new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port,method:'POST',path:'/wechat/callback'},res=>{res.resume();res.on('end',resolve)});req.on('error',reject);req.end(JSON.stringify({data:{wx_id:'fixture-user',room_id:'fixture-room',is_group:true,content:'@小鱼 你好',message_id:'2'}}));});
 await tasks[1]; assert.ok(requests.length>=2); assert.doesNotMatch(JSON.stringify(requests),/FORGOTTEN_WX_/);
});


test('group history scoped filter approves only selected entries and fails closed',async()=>{
 const rows=[{message_id:7,raw_message:'SECRET',sender:{nickname:'A'}},{message_id:8,raw_message:'VISIBLE',sender:{nickname:'B'}}];
 const bot={groupMembers:new Map([['1',[]],['2',[]]]),api:async()=>({data:{messages:rows}})};
 for(const [filter,visible] of [[async(g,ids)=>g==='1'&&ids.join(',')==='7,8'?[1]:[],true],[null,false],[async()=>{throw Error('SECRET')},false],[async()=>[9],false],[async()=>[1,1],false],[async()=>new Promise(()=>{}),false]]){
  initGroupBridge({bot,dataDir:process.env.TMPDIR,limits:{allowedGroups:['1']},historyFilter:filter});
  const r=JSON.stringify(await readGroupChat({groupId:'1'}));assert.equal(r.includes('VISIBLE'),visible);assert.ok(!r.includes('SECRET'));
  assert.ok(!JSON.stringify(await readGroupChat({groupId:'2'})).includes('VISIBLE'));
 }
});
