import {initGroupBridge,sendTurnGroupMessage} from '../src/group-bridge.js';
import fs from 'node:fs';
const [dir,id,gate] = process.argv.slice(2);
if (process.env.BRIDGE_FORCE_RACE === '1') {
 const original=fs.mkdirSync;
 fs.mkdirSync=function(p,...args){const result=original(p,...args); if(String(p).endsWith('turn-group-reservations')){fs.writeFileSync(`${dir}/reserved-${id}`,''); const end=Date.now()+600; while(Date.now()<end && (!fs.existsSync(`${dir}/reserved-a`)||!fs.existsSync(`${dir}/reserved-b`))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);} return result};
}
if (process.env.BRIDGE_FAIL_FSYNC === '1') fs.fsyncSync=()=>{throw new Error('synthetic fsync failure')};
const bot={groupMembers:new Map([['1',[]]]),send:async()=>{fs.appendFileSync(`${dir}/sent`,`${id}\n`); await new Promise(r=>setTimeout(r,150)); return {ok:true};}};
initGroupBridge({bot,dataDir:dir,limits:{allowedGroups:['1'],dailyPerGroup:Number(process.env.BRIDGE_QUOTA||1),minGapMs:0,maxGapMs:0}});
fs.writeFileSync(`${dir}/ready-${id}`,'');
while(!fs.existsSync(gate)) await new Promise(r=>setTimeout(r,5));
const result=await sendTurnGroupMessage({bot,identity:id,groupId:'1',text:'你好',dispatch:send=>send()});
console.log(JSON.stringify(result));
