import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { chromium } from 'playwright-core';
import { browserComment, closeWatchBrowser } from '../src/bili-browser.js';
process.env.BILI_COMMENT_LEDGER_DIR=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'bili-browser-'));
test('browser submission shares persistent target guard and never treats editor clear as success',async()=>{
 const old=chromium.launch; let text='',sent=0;
 const editor={first(){return this},async waitFor(){},async click(){},async innerText(){return sent?'':text}};
 const button={first(){return this},async waitFor(){},async evaluate(){return false},async click(){sent++}};
 let ev=0; const page={async goto(){},async waitForTimeout(){},async evaluate(){ev++; if(ev%3===2)return {aid:789,bvid:'BVsynthetic'};return ''},locator(s){return s.startsWith('div')?editor:button},keyboard:{async type(v){text=v}}};
 chromium.launch=async()=>({isConnected:()=>true,async close(){},async newContext(){return {async addCookies(){},async newPage(){return page},async close(){}}}});
 try { const cred={dedeuserid:'123'}; const opts={aid:789,ownerIds:['987654'],typeDelay:0}; const a=await browserComment('BVsynthetic','视频内容很有意思',cred,opts); assert.equal(a.ok,false);assert.equal(sent,1); sent=0; ev=0; const b=await browserComment('BVsynthetic','另一句内容',cred,opts); assert.equal(b.code,'comment_already_reserved'); assert.equal(sent,0); } finally {await closeWatchBrowser();chromium.launch=old;}
});
