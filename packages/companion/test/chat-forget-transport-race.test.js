import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {startScopedSend} from '../src/chat-forget-coordination.js';

const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};

test('cross-process forget cannot complete while asynchronous transport has not handed off', async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'coord-transport-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const entered=deferred(), release=deferred(); let handedOff=false;
 const sending=startScopedSend(dir,scope,'qq-private-message',()=>true,async()=>{entered.resolve();await release.promise;handedOff=true;return {ok:true};});
 await entered.promise;
 const url=new URL('../src/chat-forget-coordination.js',import.meta.url).href;
 const script=`import {withForgetWrite} from ${JSON.stringify(url)}; await withForgetWrite(process.argv[1],${JSON.stringify(scope)},'qq-private-message',()=>{}); process.stdout.write('forgotten');`;
 const child=spawn(process.execPath,['--input-type=module','-e',script,dir],{stdio:['ignore','pipe','pipe']});
 t.after(()=>{if(child.exitCode===null)child.kill();});
 let output='';child.stdout.on('data',x=>output+=x);
 await new Promise(r=>setTimeout(r,400));
 assert.equal(output,'','forget completed before asynchronous handoff');
 assert.equal(handedOff,false);
 release.resolve(); assert.deepEqual(await sending,{ok:true});
 const [code]=await once(child,'exit');assert.equal(code,0);assert.equal(output,'forgotten');
});


test('coordination does not depend on the flock executable in PATH', async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'coord-no-flock-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const url=new URL('../src/chat-forget-coordination.js',import.meta.url).href;
 const script=`import {withForgetWrite} from ${JSON.stringify(url)}; await withForgetWrite(process.argv[1],${JSON.stringify(scope)},'qq-private-message',()=>process.stdout.write('ok'));`;
 const child=spawn(process.execPath,['--input-type=module','-e',script,dir],{env:{...process.env,PATH:dir},stdio:['ignore','pipe','pipe']});
 let output='',errors='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>errors+=x);
 const [code]=await once(child,'close');assert.equal(code,0,errors);assert.equal(output,'ok');
});

test('OneBot text and voice remain locked through asynchronous fetch and recheck between parts', async t=>{
 const {OneBot}=await import('../src/transport-onebot.js');
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'coord-onebot-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const {withForgetWrite}=await import('../src/chat-forget-coordination.js');
 const original=globalThis.fetch; t.after(()=>{globalThis.fetch=original;});
 const requests=[]; let gate=deferred(), entered=deferred(), revision=0;
 globalThis.fetch=async (url,opts)=>{requests.push(JSON.parse(opts.body)); entered.resolve(); await gate.promise; return {ok:true,text:async()=>JSON.stringify({status:'ok',retcode:0})};};
 const bot=new OneBot({httpUrl:'http://synthetic.invalid',dataDir:dir});
 bot.close(); // Stop the constructor's deferred websocket connection; fetch is synthetic.
 for(const kind of ['text','voice']) {
  const captured=revision;
  const send=startScopedSend(dir,scope,'qq-private-message',()=>revision===captured,()=>kind==='text'?bot.send('private:1','hello'):bot.sendVoice('private:1','YWJj'));
  await entered.promise;
  let forgot=false; const write=withForgetWrite(dir,scope,'qq-private-message',()=>{revision++;forgot=true;});
  await new Promise(r=>setTimeout(r,30)); assert.equal(forgot,false);
  gate.resolve(); assert.equal((await send).ok,true); await write;
  const stale=await startScopedSend(dir,scope,'qq-private-message',()=>revision===captured,()=>{throw Error('stale part sent');});
  assert.equal(stale.error,'FORGET_DURING_DELIVERY');
  gate=deferred(); entered=deferred();
 }
 assert.equal(requests.length,2);
 assert.equal(requests[0].message,'hello');
 assert.equal(requests[1].message[0].type,'record');
});
