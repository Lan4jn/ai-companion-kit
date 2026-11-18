import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import path from 'node:path';
import {createPhoneMutex} from '../src/phone-mutex.js';
import {createFanqieSocialControlDriver} from '../src/fanqie-social-control.js';

const serial='fixture-device';
const pkg='com.dragon.read';
const open=`${pkg}:id/fixture_open`;
const marker=`${pkg}:id/fixture_comment_panel`;
const node=(id,bounds='[10,20][110,120]')=>`<node resource-id="${id}" clickable="true" enabled="true" bounds="${bounds}" />`;
const xml=(...nodes)=>`<hierarchy>${nodes.join('')}</hierarchy>`;
async function inLock(fn){
 const dir=await mkdtemp(path.join(process.env.TMPDIR || '/root/.hermes/cache/scratch','fanqie-test-'));
 try{return await createPhoneMutex({lockPath:path.join(dir,'phone.lock')}).runUser(fn);}finally{await rm(dir,{recursive:true,force:true});}
}
function fixture(snapshots){
 const calls=[];let n=0;
 const run=async(file,args)=>{calls.push([file,args]);
  if(args.includes('activities'))return {stdout:'mResumedActivity: ActivityRecord{abc u0 com.dragon.read/.Main t1}'};
  if(args.includes('dump'))return {stdout:snapshots[Math.min(n++,snapshots.length-1)]};
  return {stdout:''};
 };
 return {calls,driver:createFanqieSocialControlDriver({serial,configuredSerial:serial,openResourceId:open,panelResourceId:marker,run})};
}
test('已确认的评论入口在锁内稳定点击，并以新出现的面板标记核验',async()=>{
 const f=fixture([xml(node(open)),xml(node(open)),xml(node(marker))]);
 const result=await inLock(()=>f.driver.openComments());
 assert.equal(result.ok,true);
 assert.equal(f.calls.filter(([,a])=>a.includes('tap')).length,1);
 assert.ok(f.calls.every(([,a])=>a[0]==='-s'&&a[1]===serial));
});
test('未持锁时不得操作设备',async()=>{
 const f=fixture([xml(node(open))]);
 await assert.rejects(()=>f.driver.openComments(),/lock/i);assert.equal(f.calls.length,0);
});
test('控件发生变化时不得点击',async()=>{
 const f=fixture([xml(node(open)),xml(node(open,'[20,20][110,120]'))]);
 const result=await inLock(()=>f.driver.openComments());
 assert.equal(result.ok,false);assert.equal(f.calls.filter(([,a])=>a.includes('tap')).length,0);
});
test('点击未出现评论面板时不得宣称成功',async()=>{
 const f=fixture([xml(node(open)),xml(node(open)),xml(node(open))]);
 const result=await inLock(()=>f.driver.openComments());
 assert.equal(result.ok,false);assert.equal(f.calls.filter(([,a])=>a.includes('tap')).length,1);
});
