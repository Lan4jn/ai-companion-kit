import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {startScopedSend} from '../src/chat-forget-coordination.js';

const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'};
test('another process holding a forget write orders the final send check', async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'cross-forget-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const marker=path.join(dir,'forgotten');
 const module=new URL('../src/chat-forget-coordination.js',import.meta.url).href;
 const code=`import {withForgetWrite} from ${JSON.stringify(module)}; import fs from 'node:fs'; await withForgetWrite(${JSON.stringify(dir)},${JSON.stringify(scope)},'qq-private-message',async()=>{console.log('locked'); await new Promise(r=>process.stdin.once('data',r)); fs.writeFileSync(${JSON.stringify(marker)},'x');});`;
 const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['pipe','pipe','inherit']});
 const childClosed=once(child,'close');
 t.after(()=>child.kill());
 await once(child.stdout,'data');
 let sent=false;
 const pending=startScopedSend(dir,scope,'qq-private-message',()=>!fs.existsSync(marker),()=>{sent=true;return {ok:true};});
 await new Promise(r=>setTimeout(r,150));
 child.stdin.end('go');
 const result=await pending;
 assert.equal(sent,false);
 assert.equal(result.error,'FORGET_DURING_DELIVERY');
 await childClosed;
});

test('live lock times out, other scopes proceed, and a crash releases', async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'cross-lock-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const module=new URL('../src/chat-forget-coordination.js',import.meta.url).href;
 const code=`import {withForgetWrite} from ${JSON.stringify(module)}; await withForgetWrite(${JSON.stringify(dir)},${JSON.stringify(scope)},'qq-private-message',async()=>{console.log('locked'); await new Promise(()=>setInterval(()=>{},1000));});`;
 const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['pipe','pipe','inherit']});
 t.after(()=>child.kill('SIGKILL'));
 await once(child.stdout,'data');
 const other=await startScopedSend(dir,{...scope,user:'2',session:'private:2'},'qq-private-message',()=>true,()=>({ok:true}));
 assert.equal(other.ok,true);
 await assert.rejects(startScopedSend(dir,scope,'qq-private-message',()=>true,()=>({ok:true})),/lock.*(timeout|unavailable)/i);
 const closed=once(child,'close'); child.kill('SIGKILL'); await closed;
 assert.equal((await startScopedSend(dir,scope,'qq-private-message',()=>true,()=>({ok:true}))).ok,true);
});
