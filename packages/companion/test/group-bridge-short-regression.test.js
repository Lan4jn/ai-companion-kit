import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initGroupBridge, enqueueGroupMessage, startOutboxWorker, stopOutboxWorker } from '../src/group-bridge.js';
import { Humanizer } from '../src/humanize.js';

test('group bridge fails closed on oversized drafts, old queue and transformed segments', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bridge-short-'));
  const oldInterval = globalThis.setInterval; globalThis.setInterval = () => ({});
  const calls = []; const bot = {groupMembers:new Map([['1', []]]), send:async (_k, t) => {calls.push(t); return {ok:true};}, setTyping:async()=>{}};
  try {
    initGroupBridge({bot,dataDir:dir,limits:{minGapMs:0,maxGapMs:0}});
    assert.equal(enqueueGroupMessage({groupId:'1',text:'鱼'.repeat(51)}).status,'error');
    assert.equal(enqueueGroupMessage({groupId:'1',text:'鱼'.repeat(50),atQq:'123'}).status,'error');
    assert.equal(enqueueGroupMessage({groupId:'1',text:'鱼'.repeat(49)+'🐟'}).status,'ok');
    startOutboxWorker(); await new Promise(r=>setTimeout(r,30)); await stopOutboxWorker();
    assert.deepEqual(calls,['鱼'.repeat(49)+'🐟']);
    initGroupBridge({bot,dataDir:dir,human:{split:()=>['鱼'.repeat(51)],say:async (_p,o)=>o.send('鱼'.repeat(51))},limits:{minGapMs:0,maxGapMs:0}});
    assert.equal(enqueueGroupMessage({groupId:'1',text:'短'}).status,'ok');
    startOutboxWorker(); await new Promise(r=>setTimeout(r,30)); await stopOutboxWorker();
    assert.equal(calls.length,1);
  } finally { globalThis.setInterval=oldInterval; fs.rmSync(dir,{recursive:true,force:true}); }
});

test('group bridge sends each paragraph separately and stops on unknown', async () => {
  const dir=fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(),'bridge-parts-'));
  const interval=globalThis.setInterval; globalThis.setInterval=()=>({});
  const calls=[]; let unknown=false;
  const bot={groupMembers:new Map([['1',[]]]),setTyping:async()=>{},send:async (key,text)=>{calls.push([key,text]);return unknown ? {ok:false,outcome:'unknown'} : {ok:true};}};
  try {
    initGroupBridge({bot,human:new Humanizer({enabled:false}),dataDir:dir,limits:{minGapMs:0,maxGapMs:0}});
    assert.equal(enqueueGroupMessage({groupId:'1',text:'一\n\n二\n\n三'}).status,'ok');
    startOutboxWorker(); await new Promise(r=>setTimeout(r,50)); await stopOutboxWorker();
    assert.deepEqual(calls,[['group:1','一'],['group:1','二'],['group:1','三']]);
    unknown=true;
    assert.equal(enqueueGroupMessage({groupId:'1',text:'甲\n\n乙'}).status,'ok');
    startOutboxWorker(); await new Promise(r=>setTimeout(r,50)); await stopOutboxWorker();
    startOutboxWorker(); await new Promise(r=>setTimeout(r,50)); await stopOutboxWorker();
    assert.deepEqual(calls.slice(3),[['group:1','甲']]);
  } finally { await stopOutboxWorker(); globalThis.setInterval=interval; fs.rmSync(dir,{recursive:true,force:true}); }
});
