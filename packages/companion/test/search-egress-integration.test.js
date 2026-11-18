import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicSearchQuery } from '../src/search-privacy.js';
import { browseWebTopic } from '../src/web-living.js';
import { Brain } from '../src/brain.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('strict standalone allowlist rejects mixed personal material and preserves public facts', () => {
 for (const text of ['张三太阳系住址','太阳系张三病情','太阳系 abcdef','不要查太阳系是什么','RTX 5080 alice@example.com']) assert.equal(publicSearchQuery(text), '');
 for (const text of ['太阳系是什么？','影之刃零最新发售时间是什么？','RTX 5080价格是多少？']) assert.equal(publicSearchQuery(text),text);
});

test('autonomous direct topic is gated even with injected search', async () => {
 let calls=0; const dir=fs.mkdtempSync(path.join(os.tmpdir(),'web-private-'));
 try {
  const r=await browseWebTopic({brain:{},memory:{dir},topic:'张三抑郁症',search:async()=>{calls++;}});
  assert.equal(r.success,false); assert.equal(calls,0);
 } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('concurrent safe and private chats keep their search scopes separate', async t => {
 t.mock.method(globalThis,'fetch',async ()=>({ok:true,text:async()=>JSON.stringify({choices:[{message:{content:'好的'}}]})}));
 const brain=new Brain({apiKey:'test-key'}); const queries=[];
 brain.search=async (_name,{query})=>{queries.push(query); await new Promise(r=>setTimeout(r,5)); return {success:false};};
 await Promise.all([
  brain.reply({key:'private:1',userId:'1',text:'影之刃零最新发售时间是什么？',record:false}),
  brain.reply({key:'private:2',userId:'2',text:'张三患了抑郁症查一下',record:false}),
  brain.reply({key:'private:3',userId:'3',text:'别查影之刃零最新发售时间',factualSearchText:'影之刃零最新发售时间是什么？',record:false})
 ]);
 assert.deepEqual(queries,['影之刃零最新发售时间是什么？']);
});
