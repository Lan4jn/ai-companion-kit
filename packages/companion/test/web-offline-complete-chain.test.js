import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import http from 'node:http';
import {Readable} from 'node:stream';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {browseWebTopic, collectWebKnowledge, collectWebJournal, createWebScope} from '../src/web-living.js';
import {Memory} from '../src/memory.js';
import {initializeManagedStore} from '../src/memory-brain-trust.js';

const topic='怪物猎人荒野';
const quotes=['怪物猎人荒野包含合成网页的测试内容甲','怪物猎人荒野包含合成网页的测试内容乙','怪物猎人荒野包含合成网页的测试内容丙'];
test('offline discovery to source reading, scoped history, restart, chat/background recall and individual forget',async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'web-offline-e2e-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const oldFetch=globalThis.fetch, oldLookup=dns.lookup, oldGet=http.get;
 t.after(()=>{globalThis.fetch=oldFetch;dns.lookup=oldLookup;http.get=oldGet});
 let reads=[];
 globalThis.fetch=async url=>({json:async()=>String(url).includes('weibo')?{data:{realtime:[{word:topic}]}}:{}});
 dns.lookup=async()=>[{address:'93.184.216.34',family:4}];
 http.get=(url,opts,cb)=>{const req=new EventEmitter(); const i=Number(url.pathname.slice(1)); reads.push(i); process.nextTick(()=>{const res=Readable.from([Buffer.from(`<html><body>${quotes[i]}，这是为了测试来源阅读而提供的额外文字。</body></html>`)]);res.statusCode=200;res.headers={'content-type':'text/html'};cb(res)});return req};
 const memory=new Memory({dir});
 initializeManagedStore(path.join(dir,'memory-brain-scoped'));
 const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'};
 const cfg={ownerIds:['1'],dataDir:dir,memoryBrain:{enabled:true,backend:'sqlite-fts',trustedProcess:true,trustedScope:scope,authorizedSources:['web-source-page']}};
 const webScope=createWebScope(cfg,dir);
 const key=createHash('sha256').update(JSON.stringify([scope.tenant,scope.platform,scope.type,scope.session,scope.user])).digest('hex');
 const scopedDir=path.join(dir,'web-scoped',key);
 for(let i=0;i<3;i++){
  const url=`http://example.com/${i}`;
  let decisions=[];
  const brain={complete:async({prompt})=>{
   if(prompt.includes('实时热搜列表')){decisions.push('pick');return {topic,reason:'想看看'}}
   if(prompt.includes('想不想再花')){decisions.push('deep');return {deep:true,why:'想读原文'}}
   if(prompt.includes('页面证据')){decisions.push('read');assert.ok(prompt.includes(quotes[i]));return {relevant:true,quote:quotes[i]}}
   if(prompt.includes('是否想把这段原文')){decisions.push('interest');return {interested:i!==2}}
   return {details:'摘要',mood:'看看'};
  }};
  const result=await browseWebTopic({brain,memory,webScope,search:async()=>({success:true,text:`1. ${topic}相关介绍\n(来源: web ${url})`})});
  assert.equal(result.goalStatus,'completed');assert.deepEqual(decisions,['pick','deep','read','interest']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(scopedDir,'web-surfing-history.json'),'utf8')).length,1);
  // Reset only the discovery dedup history between synthetic runs.
  fs.rmSync(path.join(scopedDir,'web-surfing-history.json'));
 }
 assert.deepEqual(reads,[0,1,2]);
 assert.equal(memory.recentDiary(10).length,0); // No unscoped diary leakage.
 assert.equal(collectWebKnowledge(dir,webScope).length,2);
 assert.equal(collectWebJournal(dir,webScope).length,2);
 assert.equal(fs.readdirSync(path.join(scopedDir,'web-journal')).length,2);
 assert.deepEqual(collectWebJournal(dir,'1'),[]);
 // Exercise recovery of an interrupted marker write in the restarted process.
 fs.rmSync(path.join(scopedDir,'web-journal'),{recursive:true});
 const script=`
 import assert from 'node:assert/strict';
 import path from 'node:path';
 import {handleTurn} from './src/index.js';
 import {createWebScope,createWebBackgroundFilter,decideWebSurfing,collectWebKnowledge} from './src/web-living.js';
 import {createManagedMemoryBrain} from './src/memory-brain-trust.js';
 import {tiebaMessage} from './test/tieba-trusted-message-fixture.js';
 const dir=process.env.E2E_DIR, quotes=JSON.parse(process.env.E2E_QUOTES);
 const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'};
 const cfg={ownerIds:['1'],dataDir:dir,memoryBrain:{enabled:true,backend:'sqlite-fts',trustedProcess:true,trustedScope:scope,authorizedSources:['web-source-page']}};
 const turn=async msg=>{let result;await handleTurn({brain:{reply:async p=>(result=p,{text:''})},memory:{dir},bot:{},human:{},waker:{}},[msg],cfg);return result.situation};
 const webScope=createWebScope(cfg,dir);
 const background=async config=>{let prompt='';await decideWebSurfing({brain:{complete:async p=>(prompt=p.prompt,{want:false})},memory:{dir},webScope,backgroundFilter:createWebBackgroundFilter(config,dir)});return prompt};
 const otherScope={...scope,session:'private:2',user:'2'};
 const otherCfg={...cfg,ownerIds:['2'],memoryBrain:{...cfg.memoryBrain,trustedScope:otherScope}};
 const other=createWebScope(otherCfg,dir);
 assert.deepEqual(collectWebKnowledge(dir,other),[]);
 const owner=await tiebaMessage();let before=await turn(owner);
 let bg=await background(cfg);assert.ok(bg.includes(quotes[0])&&bg.includes(quotes[1])&&!bg.includes(quotes[2]));
 assert.ok(before.includes(quotes[0])&&before.includes(quotes[1]));assert.ok(!before.includes(quotes[2]));
 assert.ok(!(await turn(await tiebaMessage({type:'group',groupId:9}))).includes(quotes[0]));
 assert.ok(!(await turn(await tiebaMessage({userId:2}))).includes(quotes[0]));
 const store=createManagedMemoryBrain({directory:path.join(dir,'memory-brain-scoped'),scope,sources:['web-source-page'],trustedProcess:true,backend:'sqlite-fts'});
 await store.forget(scope,{source:'web-source-page',evidence:'http://example.com/0'});
 let after=await turn(owner);assert.ok(!after.includes(quotes[0])&&after.includes(quotes[1]));
 bg=await background(cfg);assert.ok(!bg.includes(quotes[0])&&bg.includes(quotes[1]));
 assert.deepEqual(collectWebKnowledge(dir,other),[]);
 console.log('OFFLINE_RESTART_RECALL_FORGET_OK');`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:process.cwd(),encoding:'utf8',env:{...process.env,E2E_DIR:dir,E2E_QUOTES:JSON.stringify(quotes)},timeout:30000});
 assert.equal(child.status,0,child.stderr+'\n'+child.stdout);assert.match(child.stdout,/OFFLINE_RESTART_RECALL_FORGET_OK/);
});
