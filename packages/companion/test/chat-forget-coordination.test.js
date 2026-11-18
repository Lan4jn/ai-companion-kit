import test from 'node:test';
import assert from 'node:assert/strict';
import {withForgetWrite, startScopedSend} from '../src/chat-forget-coordination.js';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
const directory = mkdtempSync(join(process.env.TMPDIR, 'chat-coordination-'));
test.after(() => rmSync(directory, {recursive:true, force:true}));

const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'};
const deferred=()=>{let resolve; const promise=new Promise(r=>resolve=r); return {promise,resolve};};

test('a waiting send checks after a pending forget, and an active send holds the lock', async()=>{
 const writing=deferred(), release=deferred(), network=deferred(), started=deferred(); let forgotten=false, sends=0;
 const write=withForgetWrite(directory,scope,'qq-private-message',async()=>{writing.resolve();await release.promise;forgotten=true;});
 await writing.promise;
 const send=startScopedSend(directory,scope,'qq-private-message',()=>!forgotten,()=>{sends++;return network.promise;});
 release.resolve(); await write;
 assert.deepEqual(await send,{ok:false,outcome:'permanent',sent:0,error:'FORGET_DURING_DELIVERY'});
 assert.equal(sends,0);
 const pending=startScopedSend(directory,scope,'qq-private-message',()=>true,()=>{sends++;started.resolve();return network.promise;});
 await started.promise;
 let finished=false; const waiting=withForgetWrite(directory,scope,'qq-private-message',async()=>{finished=true;});
 await new Promise(r=>setImmediate(r)); assert.equal(finished,false);
 network.resolve({ok:true}); assert.deepEqual(await pending,{ok:true}); await waiting; assert.equal(finished,true);
});

test('a stalled write does not block a different scope and failures release the queue', async()=>{
 const entered=deferred(), release=deferred();
 const write=withForgetWrite(directory,scope,'qq-private-message',async()=>{entered.resolve();await release.promise;throw Error('synthetic failure');});
 await entered.promise;
 const other={...scope,session:'private:2',user:'2'};
 assert.deepEqual(await startScopedSend(directory,other,'qq-private-message',()=>true,()=>({ok:true})),{ok:true});
 release.resolve(); await assert.rejects(write,/synthetic failure/);
 assert.deepEqual(await startScopedSend(directory,scope,'qq-private-message',()=>true,()=>({ok:true})),{ok:true});
});
