import {test} from 'node:test';
import assert from 'node:assert/strict';
import {phoneMutex} from '../src/phone-mutex.js';
import {observeFanqiePublication} from '../src/fanqie-publication-observer.js';

const activity='topResumedActivity=ActivityRecord{a u0 com.dragon.read/com.dragon.community.impl.detail.page.CSSBookCommentDetailsActivity t16}';
const xml='<?xml version="1.0"?><hierarchy><node resource-id="com.dragon.read:id/dfy" class="android.widget.EditText" text="发表评论..." enabled="true" focused="true" bounds="[28,1652][1052,1750]"/><node resource-id="com.dragon.read:id/jyu" class="android.widget.TextView" text="发表" enabled="true" clickable="true" bounds="[946,1769][1052,1820]"/></hierarchy>';
test('只读观察输入框不能证明登录或目标，禁止发表',async()=>{
 const calls=[]; const run=async (_cmd,args)=>{calls.push(args);return {stdout:args.includes('activities')?activity:args.includes('dump')?'UI hierchary dumped to: /sdcard/fanqie-publication-observer.xml':xml};};
 const result=await phoneMutex.runUser(()=>observeFanqiePublication({serial:'dedicated',configuredSerial:'dedicated',run}));
 assert.deepEqual(result,{composer:true,login:'unknown',target:null,canPublish:false});
 assert.ok(calls.every(args=>!args.includes('input')));
});
