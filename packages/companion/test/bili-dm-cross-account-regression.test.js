import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(process.env.TMPDIR, 'bili-dm-account-scope-'));
process.env.HOME = home;
const {startBiliLiving, stopBiliLiving, __debug} = await import('../src/bili-living.js');
const {createMemoryBrain} = await import('../src/memory-brain-adapter.js');
const store=createMemoryBrain({enabled:true,backend:'sqlite-fts',directory:path.join(home,'memory'),authorize:async()=>true,recoveryAuthorization:async()=>true});

test('same upstream message key in two authenticated accounts is not deduplicated across accounts', async () => {
  const previous = globalThis.fetch;
  let account = '9', calls = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const json = value => ({ok:true, text:async()=>JSON.stringify(value), json:async()=>value});
    if (u.includes('/x/web-interface/nav')) return json({code:0,data:{isLogin:true,mid:account}});
    if (u.includes('get_sessions')) return json({code:0,data:{session_list:[]}});
    if (u.includes('fetch_session_msgs')) return json({code:0,data:{messages:[{msg_key:'123',sender_uid:'42',msg_type:1,content:JSON.stringify({content:'synthetic message'}),timestamp:1700000000}]}});
    throw Error('unexpected network request');
  };
  const brain = {reply:async()=>{calls++; return {text:'{"reply":false}'};}};
  try {
    for (account of ['9','10']) {
      startBiliLiving({brain,biliDMMemory:store,credentials:{sessdata:'synthetic',dedeuserid:account},ownerMid:'42',initialDelayMs:3600000});
      try { await __debug.checkPrivateMessages(); } finally { await stopBiliLiving(); }
    }
    assert.equal(calls,2);
  } finally { globalThis.fetch=previous; fs.rmSync(home,{recursive:true,force:true}); }
});
