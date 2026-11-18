import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const home=fs.mkdtempSync(path.join(process.env.TMPDIR,'bili-dm-durable-'));
process.env.HOME=home;
const {createMemoryBrain}=await import('../src/memory-brain-adapter.js');
const {startBiliLiving,stopBiliLiving,__debug}=await import('../src/bili-living.js');
const {biliDMScope,biliDMEvidence}=await import('../src/bili-dm-ledger.js');

test('unknown send is not retried after restart; accounts isolated and tombstones honored',async()=>{
 const prev=globalThis.fetch, requests=[], sends=[];
 let account='9', ids=['1'], fail=true;
 const store=createMemoryBrain({enabled:true,backend:'sqlite-fts',directory:path.join(home,'scoped'),authorize:async()=>true,recoveryAuthorization:async()=>true});
 globalThis.fetch=async(url,opts={})=>{
  const u=String(url), json=data=>({ok:true,text:async()=>JSON.stringify(data),json:async()=>data});
  if(u.includes('/x/web-interface/nav')) return json({code:0,data:{isLogin:true,mid:Number(account)}});
  if(u.includes('get_sessions')) return json({code:0,data:{session_list:[]}});
  if(u.includes('fetch_session_msgs')) return json({code:0,data:{messages:ids.map(id=>({msg_key:id,sender_uid:'42',msg_type:1,content:JSON.stringify({content:`question-${account}-${id}`}),timestamp:1700000000+Number(id)}))}});
  if(u.includes('send_msg')) {sends.push(account); if(fail) throw Error('unknown delivery'); return json({code:0,data:{msg_key:String(100+Number(ids.at(-1)))}});}
  throw Error('network prohibited: '+u);
 };
 const start=()=>startBiliLiving({brain:{reply:async r=>{requests.push(r); return {text:JSON.stringify({reply:true,text:'answer'})};}},biliDMMemory:store,credentials:{sessdata:'synthetic',bili_jct:'synthetic',dedeuserid:account},ownerMid:'42',ownerQQ:'1',ownerIds:['99999'],initialDelayMs:3600000});
 try {
  start(); await __debug.checkPrivateMessages(); await stopBiliLiving();
  fail=false; start(); await __debug.checkPrivateMessages(); assert.deepEqual(sends,['9']);
  ids=['1','2']; await __debug.checkPrivateMessages(); assert.deepEqual(sends,['9','9']);
  await store.forget(biliDMScope('9','42'),{source:'bili-private-message',evidence:biliDMEvidence('9','42','2')});
  ids=['1','2','3']; await __debug.checkPrivateMessages();
  assert.doesNotMatch(JSON.stringify(requests.at(-1).history),/question-9-2/);
  await stopBiliLiving(); account='10'; ids=['1']; start(); await __debug.checkPrivateMessages();
  assert.deepEqual(sends,['9','9','9','10']);
  assert.doesNotMatch(JSON.stringify(requests.at(-1).history),/question-9/);
 } finally {await stopBiliLiving();globalThis.fetch=prev;fs.rmSync(home,{recursive:true,force:true});}
});
