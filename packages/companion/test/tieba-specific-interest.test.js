import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createTiebaReader} from '../src/tieba-reader.js';

test('retains only grounded, bounded specific interest once and recalls privately', async t => {
 const dir=await mkdtemp(path.join(os.tmpdir(),'tieba-specific-')); t.after(()=>rm(dir,{recursive:true,force:true}));
 const url='https://tieba.baidu.com/p/987';
 const body='我最近在玩星露谷物语，喜欢在冬天整理农场。';
 const r=createTiebaReader({enabled:true,dir,source:{list:async()=>[{url}],read:async()=>({url,forum:'肥鱼避难所吧',title:'农场日常',body})},brain:{complete:async()=>JSON.stringify({action:'continue',record:true,keywords:[],excerpt:'星露谷物语，喜欢在冬天整理农场'})}});
 assert.equal((await r.run()).saved,1); assert.equal((await r.run()).saved,0);
 const hits=await r.recall('你玩过星露谷物语吗',{isOwner:true,channel:'private'});
 assert.equal(hits.length,1); assert.equal(hits[0].excerpt,'星露谷物语，喜欢在冬天整理农场');
 assert.deepEqual(await r.recall('星露谷物语',{isOwner:false,channel:'group'}),[]);
 assert.equal((await readFile(path.join(dir,'tieba-interest.jsonl'),'utf8')).trim().split('\n').length,1);
});

test('does not persist fabricated or sensitive excerpt', async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'tieba-specific-')); t.after(()=>rm(dir,{recursive:true,force:true}));
 const url='https://tieba.baidu.com/p/988'; let excerpt='编造的事实';
 const r=createTiebaReader({enabled:true,dir,source:{list:async()=>[{url}],read:async()=>({url,forum:'肥鱼避难所吧',title:'帖子',body:'我的手机号是13800138000，今天很开心。'})},brain:{complete:async()=>JSON.stringify({action:'continue',record:true,keywords:[],excerpt})}});
 assert.equal((await r.run()).saved,0); excerpt='我的手机号是13800138000'; assert.equal((await r.run()).saved,0);
});
