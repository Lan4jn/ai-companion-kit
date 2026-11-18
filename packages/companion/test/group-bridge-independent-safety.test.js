import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {initGroupBridge, enqueueGroupMessage, startOutboxWorker, stopOutboxWorker} from '../src/group-bridge.js';
const wait = () => new Promise(r => setTimeout(r, 20));

test('retryable group does not starve other groups or reorder its own items', async () => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'bridge-fair-')); const old=globalThis.setInterval; let tick; const sent=[];
 globalThis.setInterval=fn=>{tick=fn;return {}};
 const bot={groupMembers:new Map([['1',[]],['2',[]]]),send:async(key,text)=>{sent.push([key,text]);return key==='group:1'?{ok:false,outcome:'retry'}:{ok:true}}};
 try {initGroupBridge({bot,dataDir:dir,limits:{maxPerCommand:5,minGapMs:0,maxGapMs:0}});enqueueGroupMessage({groupId:'1',text:'first'});enqueueGroupMessage({groupId:'1',text:'second'});enqueueGroupMessage({groupId:'2',text:'other'});startOutboxWorker();await wait();tick();await wait();assert.deepEqual(sent,[['group:1','first'],['group:2','other']]);const q=JSON.parse(fs.readFileSync(path.join(dir,'outbox.json'))).pending;assert.deepEqual(q.map(x=>x.text),['first','second']);} finally {await stopOutboxWorker();globalThis.setInterval=old;fs.rmSync(dir,{recursive:true,force:true});}
});

test('unclassified failed send is unknown and never replayed', async () => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'bridge-ambiguous-'));const old=globalThis.setInterval;let tick,calls=0;globalThis.setInterval=fn=>{tick=fn;return {}};
 const bot={groupMembers:new Map([['1',[]]]),send:async()=>{calls++;return {ok:false,error:'connection reset'}}};
 try {initGroupBridge({bot,dataDir:dir,limits:{minGapMs:0,maxGapMs:0}});enqueueGroupMessage({groupId:'1',text:'hello'});startOutboxWorker();await wait();tick();await wait();assert.equal(calls,1);assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'outbox.json'))).pending[0].deliveryState,'unknown');} finally {await stopOutboxWorker();globalThis.setInterval=old;fs.rmSync(dir,{recursive:true,force:true});}
});
