import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(process.env.TMPDIR, 'bili-scoped-multiturn-'));
process.env.HOME = home;
const {createMemoryBrain} = await import('../src/memory-brain-adapter.js');
const {startBiliLiving, stopBiliLiving, __debug} = await import('../src/bili-living.js');

test('authenticated DM entry remembers a successful turn in its scoped SQLite history', async () => {
  const requests = [], sends = [];
  let turn = 1;
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    const json = data => ({ok:true, text:async()=>JSON.stringify(data), json:async()=>data});
    if (u.includes('/x/web-interface/nav')) return json({code:0,data:{isLogin:true,mid:9}});
    if (u.includes('get_sessions')) return json({code:0,data:{session_list:[]}});
    if (u.includes('fetch_session_msgs')) return json({code:0,data:{messages:Array.from({length:turn}, (_,i)=>({msg_key:String(i+1),sender_uid:'42',msg_type:1,content:JSON.stringify({content:`question-${i+1}`}),timestamp:1700000000+i}))}});
    if (u.includes('send_msg')) { sends.push(options.body); return json({code:0,data:{msg_key:String(100+turn)}}); }
    throw Error('unexpected network request');
  };
  const store = createMemoryBrain({enabled:true,backend:'sqlite-fts',directory:path.join(home,'scoped'),authorize:async()=>true,recoveryAuthorization:async()=>true});
  startBiliLiving({brain:{reply:async input=>{requests.push(input); return {text:JSON.stringify({reply:true,text:`answer-${requests.length}`})};}},biliDMMemory:store,credentials:{sessdata:'synthetic',bili_jct:'synthetic',dedeuserid:'9'},ownerMid:'42',ownerQQ:'1',ownerIds:['99999'],initialDelayMs:3600000});
  try {
    await __debug.checkPrivateMessages();
    turn = 2;
    await __debug.checkPrivateMessages();
    assert.equal(sends.length,2);
    assert.equal(requests.length,2);
    assert.match(JSON.stringify(requests[1].history),/question-1/);
    assert.match(JSON.stringify(requests[1].history),/answer-1/);
  } finally {
    await stopBiliLiving();
    globalThis.fetch = previous;
    fs.rmSync(home,{recursive:true,force:true});
  }
});
