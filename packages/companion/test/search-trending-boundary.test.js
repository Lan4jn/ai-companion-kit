import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { browseWebTopic } from '../src/web-living.js';

async function run(pick) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'trend-')); const previous=globalThis.fetch; const queries=[];
 globalThis.fetch=async url => ({json:async()=> String(url).includes('weibo') ? {data:{realtime:[{word:'怪物猎人荒野最新消息'},{word:'张三病情'}]}} : {}});
 try {
  const brain={complete:async({prompt}) => prompt.includes('实时热搜列表') ? {topic:pick} : prompt.includes('想不想再花') ? {deep:false} : {details:'公开消息',mood:'看看'}};
  const result=await browseWebTopic({brain,memory:{dir},search:async(_,{query})=>{queries.push(query); return {success:true,text:`1. 【${query}】\n${query}相关资料\n(来源: web https://example.com/article)`};}});
  return {result,queries};
 } finally { globalThis.fetch=previous; fs.rmSync(dir,{recursive:true,force:true}); }
}
test('exact safe hot-list candidate reaches search',async()=>{ const {result,queries}=await run('怪物猎人荒野最新消息'); assert.equal(result.success,true); assert.deepEqual(queries,['怪物猎人荒野最新消息']); });
test('model cannot replace hot-list candidate with private or invented topic',async()=>{for(const pick of ['张三病情','怪物猎人荒野 张三住址','太阳系是什么']) {const {queries}=await run(pick); assert.deepEqual(queries,[]);}});
