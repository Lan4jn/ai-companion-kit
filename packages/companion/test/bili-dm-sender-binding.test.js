import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(process.env.TMPDIR, 'bili-dm-sender-'));
process.env.HOME = home;
const {startBiliLiving, stopBiliLiving, __debug} = await import('../src/bili-living.js');

test('DM session rejects a message whose sender is not the requested talker', async () => {
  let calls = 0;
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    const u = String(url);
    if (u.includes('/x/web-interface/nav')) return {ok:true, text:async()=>JSON.stringify({code:0,data:{isLogin:true,mid:9}})};
    if (u.includes('get_sessions')) return {ok:true, text:async()=>JSON.stringify({code:0,data:{session_list:[]}})};
    if (u.includes('fetch_session_msgs')) return {ok:true, text:async()=>JSON.stringify({code:0,data:{messages:[{msg_key:'123',sender_uid:'43',msg_type:1,content:JSON.stringify({content:'other user secret'}),timestamp:1}]}})};
    throw Error('network forbidden');
  };
  startBiliLiving({brain:{reply:async()=>{calls++;return {text:'{"reply":false}'};}},credentials:{sessdata:'fake',dedeuserid:'9'},ownerMid:'42',initialDelayMs:3600000});
  try { await __debug.checkPrivateMessages(); assert.equal(calls,0); }
  finally { await stopBiliLiving(); globalThis.fetch=oldFetch; fs.rmSync(home,{recursive:true,force:true}); }
});
