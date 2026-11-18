import test from 'node:test';
import assert from 'node:assert/strict';
import { Brain } from '../src/brain.js';
import { publicTrendingTitle } from '../src/search-privacy.js';
import { ChatterLearner } from '../src/chatter-learner.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

test('passive group meme absorption still uses the local dictionary without search', t => {
  t.mock.method(globalThis,'fetch',async()=>{ throw Error('unexpected network'); });
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'passive-meme-audit-'));
  try {
    fs.writeFileSync(path.join(dir,'meme_dictionary.json'),JSON.stringify({entries:[{term:'测试梗',meaning:'测试含义',usage:'测试接话'}]}));
    const learner=Object.create(ChatterLearner.prototype);
    Object.assign(learner,{dataDir:dir,filePath:path.join(dir,'human-insights.json'),insights:{slangs:[],habits:[],goldenSamples:[],recentThoughts:[]},unlearnedCount:0,msgThreshold:100,lastLearnedAt:0});
    learner.feed({isGroup:true,text:'大家在说测试梗'});
    assert.equal(learner.insights.slangs[0].term,'测试梗');
    assert.equal(JSON.parse(fs.readFileSync(learner.filePath)).slangs[0].usage,'测试接话');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('public ranking titles do not declassify personal health or domestic abuse details', () => {
  for (const title of ['张三确诊癌症','李四家暴细节曝光','张三住院治疗','王某感染艾滋病毒']) assert.equal(publicTrendingTitle(title),'',title);
  assert.equal(publicTrendingTitle('新款掌机发布引发热议'),'新款掌机发布引发热议');
});

test('all explicit search prohibitions override a separately supplied safe factual query', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ok:true,text:async()=>JSON.stringify({choices:[{message:{content:'好，不查'}}]})}));
  const brain = new Brain({apiKey:'unused', baseUrl:'https://invalid.example', model:'mock'});
  let calls=0; brain.search=async()=>{calls++;return {success:false};};
  for (const text of ['不想查影之刃零最新发售时间', '不能搜索影之刃零最新发售时间']) {
    await brain.reply({key:'private:42',userId:'42',text,factualSearchText:'影之刃零最新发售时间是什么？',record:false});
  }
  assert.equal(calls,0);
});
