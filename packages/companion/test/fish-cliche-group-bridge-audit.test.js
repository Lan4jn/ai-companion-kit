import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {initGroupBridge,enqueueGroupMessage,startOutboxWorker,stopOutboxWorker,getOutboxStatus} from '../src/group-bridge.js';

test('group bridge blocks standalone drafts but preserves CQ-bearing queue entries',async()=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'fish-bridge-'));
 let calls=0; const bot={groupMembers:new Map([['1',[]]]),send:async()=>{calls++;return {ok:true}}};
 try {
  initGroupBridge({bot,dataDir:dir});
  assert.equal(enqueueGroupMessage({groupId:'1',text:'这条我认'}).status,'error');
  assert.equal(getOutboxStatus().pending,0);
  fs.writeFileSync(path.join(dir,'outbox.json'),JSON.stringify({pending:[{gid:'1',text:'[CQ:at,qq=5] 这条我认'}]}));
  initGroupBridge({bot,dataDir:dir,limits:{minGapMs:0,maxGapMs:0}});
  startOutboxWorker(); await new Promise(r=>setTimeout(r,30)); await stopOutboxWorker();
  assert.equal(calls,1); assert.equal(getOutboxStatus().pending,0);
 } finally {await stopOutboxWorker(); fs.rmSync(dir,{recursive:true,force:true})}
});
