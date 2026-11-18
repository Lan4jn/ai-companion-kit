import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {saveFanqieMemory,recallFanqie} from '../src/fanqie-session.js';

test('明确询问最近读的小说召回最近的有原文记录，而非无关闲聊或只有摘要的历史',async t=>{
 const dir=await fs.mkdtemp(path.join(process.env.TMPDIR,'fanqie-recent-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 await saveFanqieMemory(dir,{source:'OCR',text:'古城的夜空落下细雨',summary:'古城下雨',fingerprint:'1',keywords:[]});
 await saveFanqieMemory(dir,{source:'OCR',summary:'不应作为已读原文',fingerprint:'2',keywords:[]});
 assert.equal((await recallFanqie(dir,'你最近看了什么小说？'))[0]?.text,'古城的夜空落下细雨');
 assert.deepEqual(await recallFanqie(dir,'你最近吃了什么？'),[]);
});
