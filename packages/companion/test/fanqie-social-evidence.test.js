import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inspectFanqieEvidence} from '../src/fanqie-social-evidence.js';
import {createFanqiePublicationDeviceIO} from '../src/fanqie-social-device.js';
import {phoneMutex} from '../src/phone-mutex.js';
const profile='com.dragon.read/.social.profile.ProfileActivity';
const detail='com.dragon.read/com.dragon.community.impl.detail.page.CSSBookCommentDetailsActivity';
const xml=s=>`<?xml version="1.0"?><hierarchy>${s}</hierarchy>`;
const p=xml('<node content-desc="profile avatar"/><node class="android.widget.TextView" text="测试昵称"/><node text="编辑资料"/>');
const d=xml('<node text="书评详情"/><node resource-id="com.dragon.read:id/jbr" text="测试书"/><node resource-id="com.dragon.read:id/text" text="真实书评"/>');
test('visible profile and review never create stable identities',()=>{
 assert.deepEqual(inspectFanqieEvidence({activity:profile,xml:p}).profile,{displayName:'测试昵称',ownProfileVisible:true,stableAccountId:null});
 assert.deepEqual(inspectFanqieEvidence({activity:detail,xml:d}).review,{bookTitle:'测试书',reviewText:'真实书评',stableReviewId:null});
 assert.equal(inspectFanqieEvidence({activity:profile,xml:p.replace('编辑资料','登录')}).profile,null);
 assert.equal(inspectFanqieEvidence({activity:detail,xml:d.replace('</hierarchy>','')}).review,null);
});
test('adapter requires lock and rejects stale dump',async()=>{
 const serial='fixture';const io=createFanqiePublicationDeviceIO({serial,configuredSerial:serial,run:async(_c,args)=>args.includes('activities')?{stdout:`topResumedActivity=ActivityRecord{a u0 ${profile} t1}`}:{stdout:'UI hierchary dumped to: /sdcard/fanqie-social-evidence.xml',stderr:'ERROR: could not get idle state'}});
 await assert.rejects(io.observeEvidence(),/mutex/);
 await phoneMutex.runUser(async()=>assert.deepEqual(await io.observeEvidence(),{profile:null,review:null}));
});
