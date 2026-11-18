import {startBiliLiving,__debug} from '../../src/bili-living.js';
import {createBiliDMMemory} from '../../src/bili-dm-startup.js';
const store=createBiliDMMemory({enabled:true,directory:process.env.FIXTURE_STORE,account:'9',peers:['42']});
globalThis.fetch=async url=>{
 const u=String(url), json=x=>({ok:true,text:async()=>JSON.stringify(x),json:async()=>x});
 if(u.includes('/x/web-interface/nav')) return json({code:0,data:{isLogin:true,mid:9}});
 if(u.includes('get_sessions')) return json({code:0,data:{session_list:[]}});
 if(u.includes('fetch_session_msgs')) return json({code:0,data:{messages:[{msg_key:'1',sender_uid:'42',msg_type:1,content:JSON.stringify({content:'crash synthetic'}),timestamp:1700000000}]}});
 if(u.includes('send_msg')) { process.send('send'); return new Promise(()=>{}); }
 throw Error('network forbidden');
};
startBiliLiving({biliDMMemory:store,brain:{reply:async()=>({text:'{"reply":true,"text":"answer"}'})},credentials:{sessdata:'fake',bili_jct:'fake',dedeuserid:'9'},ownerMid:'42',ownerQQ:'1',ownerIds:['99999'],initialDelayMs:3600000});
await __debug.checkPrivateMessages(); process.send('done'); process.exit(0);
