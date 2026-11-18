import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const home=fs.mkdtempSync(path.join(process.env.TMPDIR,'bili-nav-binding-'));
process.env.HOME=home;
const {startBiliLiving,stopBiliLiving,__debug}=await import('../src/bili-living.js');

test('rejects the claimed account when authenticated nav identifies another account',async()=>{
 let replies=0;
 const old=globalThis.fetch;
 globalThis.fetch=async url=>{
  const u=String(url);
  if(u.includes('/x/web-interface/nav')) return {ok:true,text:async()=>JSON.stringify({code:0,data:{isLogin:true,mid:10}})};
  if(u.includes('get_sessions')) return {ok:true,text:async()=>JSON.stringify({code:0,data:{session_list:[]}})};
  if(u.includes('fetch_session_msgs')) return {ok:true,text:async()=>JSON.stringify({code:0,data:{messages:[{msg_key:'123',sender_uid:'42',msg_type:1,content:'{"content":"hello"}',timestamp:1}]}})};
  throw Error('network forbidden');
 };
 startBiliLiving({brain:{reply:async()=>{replies++;return {text:'{"reply":false}'};}},credentials:{sessdata:'synthetic',dedeuserid:'9'},ownerMid:'42',initialDelayMs:3600000});
 try {await __debug.checkPrivateMessages();assert.equal(replies,0);} finally {await stopBiliLiving();globalThis.fetch=old;fs.rmSync(home,{recursive:true,force:true});}
});
