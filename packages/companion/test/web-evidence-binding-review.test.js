import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {browseWebTopic, collectWebKnowledge, createWebBackgroundFilter, createWebScope} from '../src/web-living.js';
import {initializeManagedStore, createManagedMemoryBrain} from '../src/memory-brain-trust.js';

const topic = '怪物猎人荒野';
const quote = `${topic}包含一个公开测试内容`;
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'web-binding-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const result = await browseWebTopic({topic, memory:{dir, logDiary(){}},
    search:async()=>({success:true,text:`1. 【${topic}】\n${topic}相关资料\n(来源: web https://example.com/article)`}),
    readEvidence:async()=>({url:'https://example.com/article',text:quote,sha256:'a'.repeat(64)}),
    brain:{complete:async({prompt}) => prompt.includes('想不想再花')?{deep:true}:prompt.includes('页面证据')?{relevant:true,quote}:prompt.includes('是否想把')?{interested:true}:{details:'',mood:''}}});
  assert.equal(result.goalStatus, 'completed');
  assert.equal(collectWebKnowledge(dir).length,1);
  const statePath=path.join(dir,'web-goals.json');
  const state=JSON.parse(fs.readFileSync(statePath));
  const desire=Object.values(state.desires)[0];
  return {dir,statePath,state,desire,event:state.events[desire.outcomeEventId], evidencePath:path.join(dir,'web-goal-evidence',`${desire.id}.json`)};
}

test('recall rejects evidence modified after the completed event',async t=>{
  const f=await fixture(t);
  const e=JSON.parse(fs.readFileSync(f.evidencePath));
  e.quote=e.interest.quote=e.text=`${topic}添加了新的公开装备内容`;
  fs.writeFileSync(f.evidencePath,JSON.stringify(e));
  assert.deepEqual(collectWebKnowledge(f.dir),[]);
});

test('recall rejects an outcome reference replaced with another file',async t=>{
  const f=await fixture(t);
  f.event.evidence.ref=path.join(f.dir,'web-goal-evidence','other.json');
  fs.writeFileSync(f.statePath,JSON.stringify(f.state));
  assert.deepEqual(collectWebKnowledge(f.dir),[]);
});

test('concurrent source write and forget cannot resurrect a forgotten URL',async t=>{
  const f=await fixture(t);
  const directory=path.join(f.dir,'memory-brain-scoped');
  initializeManagedStore(directory);
  const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'};
  const store=createManagedMemoryBrain({directory,scope,sources:['web-source-page'],trustedProcess:true,backend:'sqlite-fts'});
  const cfg={ownerIds:['1'],dataDir:f.dir,memoryBrain:{enabled:true,backend:'sqlite-fts',trustedProcess:true,trustedScope:scope,authorizedSources:['web-source-page']}};
  const filter=createWebBackgroundFilter(cfg,f.dir);
  const evidence='https://example.com/article';
  await Promise.allSettled([
    store.forget(scope,{source:'web-source-page',evidence}),
    store.remember(scope,{source:'web-source-page',evidence,text:quote})
  ]);
  assert.deepEqual(await filter(collectWebKnowledge(f.dir)),[]);
  await assert.rejects(store.remember(scope,{source:'web-source-page',evidence,text:quote}));
  assert.deepEqual(await filter(collectWebKnowledge(f.dir)),[]);
});

test('owner and source scope mismatches fail closed',async t=>{
  const f=await fixture(t);
  initializeManagedStore(path.join(f.dir,'memory-brain-scoped'));
  const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'};
  const cfg={ownerIds:['2'],dataDir:f.dir,memoryBrain:{enabled:true,backend:'sqlite-fts',trustedProcess:true,trustedScope:scope,authorizedSources:['web-source-page']}};
  assert.deepEqual(await createWebBackgroundFilter(cfg,f.dir)(collectWebKnowledge(f.dir)),[]);
  cfg.ownerIds=['1']; cfg.memoryBrain.authorizedSources=['tieba'];
  assert.deepEqual(await createWebBackgroundFilter(cfg,f.dir)(collectWebKnowledge(f.dir)),[]);
});

// Same storage directory, distinct trusted identities: data must never cross scopes.
test('same directory concurrent owner scopes cannot see each other’s web evidence',async t=>{
  const f=await fixture(t);
  initializeManagedStore(path.join(f.dir,'memory-brain-scoped'));
  const scope=user=>({tenant:'companion',platform:'qq',type:'private',session:`private:${user}`,user});
  const config=user=>({ownerIds:[user],dataDir:f.dir,memoryBrain:{enabled:true,backend:'sqlite-fts',trustedProcess:true,trustedScope:scope(user),authorizedSources:['web-source-page']}});
  const a=createWebScope(config('1'),f.dir), b=createWebScope(config('2'),f.dir);
  assert.deepEqual(collectWebKnowledge(f.dir,a),[]); // unattributed legacy evidence is never imported
  const result=await browseWebTopic({topic,memory:{dir:f.dir},webScope:a,
    search:async()=>({success:true,text:`1. 【${topic}】\n${topic}相关资料\n(来源: web https://example.com/article)`}),
    readEvidence:async()=>({url:'https://example.com/article',text:quote}),
    brain:{complete:async({prompt}) => prompt.includes('想不想再花')?{deep:true}:prompt.includes('页面证据')?{relevant:true,quote}:prompt.includes('是否想把')?{interested:true}:{details:'摘要',mood:'看看'}}});
  assert.equal(result.goalStatus,'completed');
  const rows=collectWebKnowledge(f.dir,a);
  const [allowed,denied]=await Promise.all([createWebBackgroundFilter(config('1'),f.dir)(rows),createWebBackgroundFilter(config('2'),f.dir)(rows)]);
  assert.equal(allowed.length,1);
  assert.deepEqual(denied,[]);
  assert.deepEqual(collectWebKnowledge(f.dir,b),[]);
});
