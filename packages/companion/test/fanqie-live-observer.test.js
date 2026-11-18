import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createPhoneMutex } from '../src/phone-mutex.js';
import { observeFanqieCandidates } from '../src/fanqie-device-navigation.js';

test('real observer parses only current fake-device page while holding actual mutex', async t=>{
 const dir=await fs.mkdtemp(path.join(process.env.TMPDIR,'fq-observer-')); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const adb=path.join(dir,'adb');
 await fs.writeFile(adb,`#!/bin/sh\ncase "$*" in\n *dumpsys*) printf 'mCurrentFocus=com.dragon.read/.MainActivity\\n';;\n *uiautomator*) printf 'UI hierchary dumped to: /sdcard/window.xml\\n';;\n *exec-out*) printf '%s' '<hierarchy><node text="书城" bounds="[0,0][100,50]"/><node resource-id="com.dragon.read:id/book_title" text="星海旅人" bounds="[10,100][200,130]"/><node resource-id="com.dragon.read:id/book_desc" text="这是来自当前屏幕的一段足够长的真实简介，讲述一场星海中的漫长旅途。" bounds="[10,140][400,200]"/></hierarchy>';;\n *) exit 1;;\nesac\n`,{mode:0o755});
 const oldPath=process.env.PATH,oldSerial=process.env.PHONE_SERIAL; process.env.PATH=dir+path.delimiter+oldPath;process.env.PHONE_SERIAL='fake';
 t.after(()=>{process.env.PATH=oldPath;if(oldSerial===undefined)delete process.env.PHONE_SERIAL;else process.env.PHONE_SERIAL=oldSerial});
 await assert.rejects(()=>observeFanqieCandidates({serial:'fake'}),/mutex/);
 const mutex=createPhoneMutex({lockPath:path.join(dir,'phone.lock')}); let result;
 assert.equal(await mutex.tryBackground(async()=>{result=await observeFanqieCandidates({serial:'fake'})}),true);
 assert.equal(result.ok,true); assert.equal(result.candidates[0].title,'星海旅人');
});


test('failed dump stderr prevents reading stale XML',async t=>{
 const dir=await fs.mkdtemp(path.join(process.env.TMPDIR,'fq-stale-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 await fs.writeFile(path.join(dir,'adb'),`#!/bin/sh\ncase "$*" in\n *dumpsys*) echo 'mCurrentFocus=com.dragon.read/.MainActivity';;\n *uiautomator*) echo 'UI hierchary dumped to: /sdcard/window.xml'; echo 'ERROR: could not get idle state' >&2;;\n *exec-out*) touch '${dir}/read';;\nesac\n`,{mode:0o755});
 const oldPath=process.env.PATH,oldSerial=process.env.PHONE_SERIAL;process.env.PATH=dir+path.delimiter+oldPath;process.env.PHONE_SERIAL='fake';
 t.after(()=>{process.env.PATH=oldPath;if(oldSerial===undefined)delete process.env.PHONE_SERIAL;else process.env.PHONE_SERIAL=oldSerial});
 let result;await createPhoneMutex({lockPath:path.join(dir,'lock')}).tryBackground(async()=>{result=await observeFanqieCandidates({serial:'fake'})});
 assert.equal(result.ok,false);await assert.rejects(fs.stat(path.join(dir,'read')),{code:'ENOENT'});
});
