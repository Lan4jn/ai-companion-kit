import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createPhoneMutex} from '../src/phone-mutex.js';
import {createFanqieReviewReader} from '../src/fanqie-review-reader.js';
import {mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const serial='test-device';
const xml = s => `<?xml version="1.0"?><hierarchy>${s}</hierarchy>`;
const sheet=xml('<node text="书籍详情"/><node text="书圈"/><node text="5.9万人点评" resource-id="com.dragon.read:id/hoo" clickable="true" enabled="true" bounds="[56,1463][205,1509]"/>');
const review=xml('<node text="搜索 测试书 的书评" resource-id="com.dragon.read:id/dg_"/><node text="实测&#10;书评 &amp; 内容" resource-id="com.dragon.read:id/text"/>');
async function fixture({initial=sheet, second=sheet, after=review}={}) {
 let activity='com.dragon.read/.reader.ui.ReaderActivity', current=initial, dumps=0, taps=0;
 const run=async(_cmd,args)=>{const cmd=args.slice(2).join(' ');if(cmd.includes('dumpsys activity'))return {stdout:`topResumedActivity=ActivityRecord{aa u0 ${activity} t1}`};if(cmd.includes('uiautomator dump')){dumps++;if(activity.endsWith('ReaderActivity'))current=dumps===1?initial:second;return {stdout:'UI hierchary dumped to: /sdcard/fanqie-review-reader.xml'};}if(cmd.startsWith('exec-out cat'))return {stdout:current};if(cmd.startsWith('shell input tap')){taps++;activity='com.dragon.read/com.dragon.community.impl.list.page.CSSBookCommentListActivity';current=after;return {stdout:''};}throw Error(cmd)};
 const dir=await mkdtemp(path.join(process.env.TMPDIR||os.tmpdir(),'fq-review-'));const mutex=createPhoneMutex({lockPath:path.join(dir,'phone.lock')});
 return {d:createFanqieReviewReader({serial,configuredSerial:serial,run,wait:async()=>{}}),mutex,taps:()=>taps};
}
test('opens a confirmed review list and reads text, no interaction IDs',async()=>{const f=await fixture();await f.mutex.runUser(async()=>{assert.deepEqual(await f.d.openComments(),{ok:true});assert.deepEqual(await f.d.readComments(),[{text:'实测\n书评 & 内容'}])});assert.equal(f.taps(),1)});
test('requires shared lock',async()=>{const f=await fixture();await assert.rejects(f.d.openComments(),/mutex lock lost/i);assert.equal(f.taps(),0)});
test('refuses changed or ambiguous review entry and agreements',async()=>{for(const value of [xml('<node text="书圈"/>'),sheet.replace('[56,1463][205,1509]','[56,1462][205,1509]'),sheet.replace('</hierarchy>','<node text="用户协议"/></hierarchy>'),sheet.replace('</hierarchy>','<node text="1人点评" resource-id="com.dragon.read:id/hoo" clickable="true" enabled="true" bounds="[0,0][10,10]"/></hierarchy>')]){const f=await fixture({second:value});await f.mutex.runUser(async()=>assert.deepEqual(await f.d.openComments(),{ok:false}));assert.equal(f.taps(),0)}});
test('fails closed if panel cannot be verified',async()=>{const f=await fixture({after:xml('<node text="其他"/>')});await f.mutex.runUser(async()=>{assert.deepEqual(await f.d.openComments(),{ok:false});assert.equal(await f.d.readComments(),null)})});
