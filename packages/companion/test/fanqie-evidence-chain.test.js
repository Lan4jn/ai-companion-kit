import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFanqieIntegration } from '../src/fanqie-integration.js';
import { createPhoneMutex } from '../src/phone-mutex.js';
import { recallFanqie } from '../src/fanqie-session.js';

async function run(nav, dir) {
 const integration=createFanqieIntegration({serial:'test',brain:{complete:async()=>JSON.stringify({interested:true,continueReading:false,summary:'人物在营地',keywords:['营地']})},memoryDir:dir,want:async()=>true,mutex:createPhoneMutex({lockPath:path.join(dir,'phone.lock')}),online:async()=>true,navigate:async()=>nav,progress:async()=>({chapter:'第一章',page:1,total:3}),capture:async()=>({text:'真实OCR正文\n第二行',source:'屏幕OCR',fingerprint:'p1'}),gesture:async()=>{throw Error('unexpected')}});
 assert.equal((await integration.run()).ok,true);
 return (await recallFanqie(dir,'营地'))[0];
}

test('真实正文和导航确认的书名进入持久记忆',async()=>{
 const dir=await fs.mkdtemp(path.join(process.env.TMPDIR||os.tmpdir(),'fanqie-evidence-'));
 try { const row=await run({ok:true,bookTitle:'验证书名'},dir);assert.equal(row.text,'真实OCR正文\n第二行');assert.equal(row.bookTitle,'验证书名');assert.equal(row.fingerprint,'p1');assert.deepEqual(row.progress,{chapter:'第一章',page:1,total:3});assert.equal(row.source,'屏幕OCR');assert.equal('bookId' in row,false); }
 finally {await fs.rm(dir,{recursive:true,force:true});}
});

test('恢复已有阅读页时不猜书籍身份',async()=>{
 const dir=await fs.mkdtemp(path.join(process.env.TMPDIR||os.tmpdir(),'fanqie-evidence-'));
 try { const row=await run({ok:true,resumed:true},dir);assert.equal(row.text,'真实OCR正文\n第二行');assert.equal('bookId' in row,false);assert.equal('bookTitle' in row,false); }
 finally {await fs.rm(dir,{recursive:true,force:true});}
});
