import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const home=fs.mkdtempSync(path.join(process.env.TMPDIR,'bili-dm-test-'));
process.env.HOME=home;
const {Brain}=await import('../src/brain.js');
const {startBiliLiving,stopBiliLiving,__debug,parseBiliDMReply}=await import('../src/bili-living.js');
const {createMemoryBrain}=await import('../src/memory-brain-adapter.js');
const store=createMemoryBrain({enabled:true,backend:'sqlite-fts',directory:path.join(home,'scoped'),authorize:async()=>true,recoveryAuthorization:async()=>true});

test('Bili DM does not pass unfiltered or recalled private history into real Brain',async t=>{
 t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const requests=[];
 t.mock.method(globalThis,'fetch',async (url,opt={})=>{
  const u=String(url);
  if(u.includes('/x/web-interface/nav')) return {ok:true,text:async()=>JSON.stringify({code:0,data:{isLogin:true,mid:9}})};
  if(u.includes('get_sessions')) return {ok:true,text:async()=>JSON.stringify({code:0,data:{session_list:[]}})};
  if(u.includes('fetch_session_msgs')) return {ok:true,text:async()=>JSON.stringify({code:0,data:{messages:[{msg_key:'123',sender_uid:'42',msg_type:1,content:JSON.stringify({content:'你好'}),timestamp:Math.floor(Date.now()/1000)}]}})};
  if(u.includes('invalid.local')) {requests.push(JSON.parse(opt.body));return {ok:true,text:async()=>JSON.stringify({choices:[{message:{content:'{"reply":false}'}}]})};}
  throw Error('network forbidden '+u);
 });
 const memory={dir:home,sessionTurns:()=>[{who:'x',text:'FORGOTTEN_HISTORY'}],recallTurns:()=>[{who:'x',text:'CROSS_SCOPE_RECALL'}],renderPerson:()=>'',renderRecent:()=>''};
 const brain=new Brain({apiKey:'fake',baseUrl:'http://invalid.local',model:'test',memory,dataDir:home,ownerIds:['1'],role:{build:({situation='',memory='',recent=''})=>situation+memory+recent}});
 startBiliLiving({brain,memory,biliDMMemory:store,credentials:{sessdata:'fake',dedeuserid:'9'},ownerMid:'42',ownerQQ:'1',initialDelayMs:3600000,biliFragmentScope:{tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'},biliBackgroundFilter:async()=>{throw Error('store unavailable')}});
 try {await __debug.checkPrivateMessages();} finally {await stopBiliLiving();}
 assert.equal(requests.length,1);
 const prompt=JSON.stringify(requests[0].messages);
 assert.doesNotMatch(prompt,/FORGOTTEN_HISTORY|CROSS_SCOPE_RECALL/);
});

test('Bili DM output is strictly JSON, nonempty and at most 50 characters',()=>{
 assert.equal(parseBiliDMReply('plain text'),null);
 assert.equal(parseBiliDMReply('{"reply":false}'),null);
 assert.equal(parseBiliDMReply(JSON.stringify({reply:true,text:'甲'.repeat(51)})),null);
 assert.equal(parseBiliDMReply(JSON.stringify({reply:true,text:'甲'.repeat(50)})),'甲'.repeat(50));
});
