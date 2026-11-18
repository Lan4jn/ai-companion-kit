import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Waker } from '../src/wake.js';
import { ChatBatchQueue } from '../src/chat-batch-queue.js';

for (const count of [6, 7, 12]) {
  test(`accepted ${count} messages preserve order with no loss at batch boundary`, async () => {
    const batches = [];
    const q = new ChatBatchQueue({waker:new Waker(), run:async items => { batches.push(items.map(m=>m.text)); return {ok:true}; }});
    for (let n=0; n<count; n++) q.add('private:a', {key:'private:a',userId:'a',text:String(n)}, 60000);
    q.stop(); await q.drain();
    assert.deepEqual(batches.flat(), Array.from({length:count}, (_, n)=>String(n)));
    assert.deepEqual(batches.map(b=>b.length), count === 6 ? [6] : count === 7 ? [6,1] : [6,6]);
  });
}

test('failure blocks future same-group users but not another conversation', async () => {
  const calls=[];
  const q = new ChatBatchQueue({waker:new Waker(), run:async items=>{calls.push(items[0].key+':'+items[0].userId); return {ok:items[0].userId!=='a'};}});
  for (const [group,user] of [['group:g','a'],['group:g','b'],['group:h','c']])
    for(let n=0;n<6;n++) q.add(`${group}:${user}`, {key:group,userId:user,text:String(n)}, 60000);
  q.stop(); await assert.rejects(q.drain());
  assert.deepEqual(calls.sort(), ['group:g:a','group:h:c']);
  assert.equal(q.undelivered.length,2);
});

test('actual SIGTERM enforces deadline for a stuck batch without retries', {timeout:10000}, async () => {
  const index = new URL('../src/index.js', import.meta.url).href;
  const wake = new URL('../src/wake.js', import.meta.url).href;
  const queue = new URL('../src/chat-batch-queue.js', import.meta.url).href;
  const source = `
    import {setupProductionFanqie} from ${JSON.stringify(index)};
    import {Waker} from ${JSON.stringify(wake)};
    import {ChatBatchQueue} from ${JSON.stringify(queue)};
    let calls=0;
    const q=new ChatBatchQueue({waker:new Waker(),run:()=>{console.log('CALL:'+ ++calls); return new Promise(()=>{});}});
    for(let n=0;n<7;n++) q.add('p',{key:'p',userId:'a',text:String(n)},60000);
    setupProductionFanqie({cfg:{},start:()=>null,beforeStop:()=>q.stop(),drain:()=>q.drain(),shutdownTimeoutMs:100});
    console.log('READY');
  `;
  const child=spawn(process.execPath,['--input-type=module','-e',source],{stdio:['ignore','pipe','pipe']});
  let out='', err='', signaled=false;
  child.stdout.on('data', chunk=>{out+=chunk; if(out.includes('READY')&&!signaled){signaled=true;child.kill('SIGTERM');}});
  child.stderr.on('data', chunk=>{err+=chunk;});
  try {
    const result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
    assert.deepEqual(result,{code:1,signal:null},out+err);
    assert.match(err,/超时/);
    assert.equal((out.match(/CALL:/g)||[]).length,1);
  } finally {if(child.exitCode===null&&child.signalCode===null) child.kill('SIGKILL');}
});
