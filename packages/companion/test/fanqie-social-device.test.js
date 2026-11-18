import {test} from 'node:test';
import assert from 'node:assert/strict';
import {phoneMutex} from '../src/phone-mutex.js';
import {createFanqiePublicationDeviceIO} from '../src/fanqie-social-device.js';

const serial='192.168.31.160:16384';
test('真实设备适配只返回已观测证据，缺少身份及目标时禁止所有写操作',async()=>{
 const calls=[];
 const io=createFanqiePublicationDeviceIO({serial,configuredSerial:serial,run:async(_cmd,args)=>{calls.push(args);return {stdout:'topResumedActivity=ActivityRecord{a u0 com.phoenix.read/com.dragon.read.pages.main.MainFragmentActivity t1}'};}});
 await phoneMutex.runUser(async()=>{
  const state=await io.observe();
  assert.equal(state.authenticated,false); assert.equal(state.accountId,null); assert.equal(state.target,null); assert.equal(state.baselineComplete,false);
  await assert.rejects(io.fill('文字')); await assert.rejects(io.submit());
  assert.equal(await io.readBack(),null);
 });
 assert.equal(calls.length,1);assert.ok(calls.every(a=>a[0]==='-s'&&a[1]===serial));
});
test('未持有共享锁不得读取设备',async()=>{
 const io=createFanqiePublicationDeviceIO({serial,configuredSerial:serial,run:async()=>{throw Error('unexpected adb')}});
 await assert.rejects(io.observe());
});
