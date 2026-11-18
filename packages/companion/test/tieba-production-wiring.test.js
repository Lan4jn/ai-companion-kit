import test from 'node:test';
import assert from 'node:assert/strict';
import * as entry from '../src/index.js';
const setupProductionTieba = (...args) => entry.setupProductionTieba?.(...args);
import { Brain } from '../src/brain.js';

test('production wiring requires explicit opt-in and dry run stays inert', () => {
 let made=0, started=0, stopped=0;
 const makeSource=()=>{made++;return {};};
 const makeScheduler=()=>({start(){started++;},stop(){stopped++;}});
 for (const cfg of [{},{tieba:{enabled:true},dryRun:true}]) assert.equal(setupProductionTieba({cfg,brain:{},makeSource,makeScheduler}),null);
 assert.equal(made,0);
 const h=setupProductionTieba({cfg:{tieba:{enabled:true},dataDir:'/synthetic'},brain:{},makeSource,makeScheduler});
 assert.equal(made,1);assert.equal(started,1);h.stop();assert.equal(stopped,1);
});

test('Brain.complete propagates cancellation to actual fetch', async t => {
 const original=globalThis.fetch; t.after(()=>globalThis.fetch=original);
 let observed;
 globalThis.fetch=async (_url,opts)=>{observed=opts.signal;return await new Promise((_,reject)=>opts.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));};
 const controller=new AbortController();
 const brain=new Brain({apiKey:'fake',baseUrl:'https://invalid.example/v1',model:'fake',timeoutMs:5000});
 const pending=brain.complete({prompt:'synthetic',signal:controller.signal});
 controller.abort();
 assert.equal(await pending,null);assert.equal(observed.aborted,true);
});
