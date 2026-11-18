import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {initGroupBridge, enqueueGroupMessage, startOutboxWorker, stopOutboxWorker} from '../src/group-bridge.js';
test('contradictory success and unknown is held, not confirmed', async () => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'bridge-contradict-'));const old=globalThis.setInterval;let tick,calls=0;globalThis.setInterval=fn=>{tick=fn;return {}};
 const bot={groupMembers:new Map([['1',[]]]),send:async()=>{calls++;return {ok:true,outcome:'unknown'}}};
 try {initGroupBridge({bot,dataDir:dir,limits:{minGapMs:0,maxGapMs:0}});enqueueGroupMessage({groupId:'1',text:'hello'});startOutboxWorker();await new Promise(r=>setTimeout(r,20));tick();await new Promise(r=>setTimeout(r,20));assert.equal(calls,1);assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'outbox.json'))).pending[0].deliveryState,'unknown');} finally {await stopOutboxWorker();globalThis.setInterval=old;fs.rmSync(dir,{recursive:true,force:true});}
});
