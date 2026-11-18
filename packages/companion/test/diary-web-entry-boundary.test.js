import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {browseWebTopic, createWebScope, collectGeneratedWebJournal} from '../src/web-living.js';
import {initializeManagedStore, createManagedMemoryBrain} from '../src/memory-brain-trust.js';
import {generateDailyDiary, readScopedDiary, listAllDiaries} from '../src/diary-system.js';
import {execFileSync, spawn} from 'node:child_process';
import {handleTurn} from '../src/index.js';
import {tiebaMessage} from './tieba-trusted-message-fixture.js';

test('actual diary generation sees only its trusted owner’s interested web journal', async t => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'diary-web-entry-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  initializeManagedStore(path.join(dir, 'memory-brain-scoped'));
  const cfg = user => ({dataDir:dir, ownerIds:[user], memoryBrain:{enabled:true, backend:'sqlite-fts', trustedProcess:true, trustedScope:{tenant:'companion', platform:'qq', type:'private', session:`private:${user}`, user}, authorizedSources:['web-source-page']}});
  const caps = ['1','2'].map(user => createWebScope(cfg(user), dir));
  const quotes = ['Steam游戏包含一个公开测试内容', 'Steam游戏包含另一个独立测试内容'];
  for (const [i, cap] of caps.entries()) {
    const url = `https://example.com/${i}`;
    await browseWebTopic({topic:'Steam游戏', memory:{dir}, webScope:cap,
      search:async()=>({success:true,text:`1. Steam游戏相关介绍\n(来源: web ${url})`}),
      readEvidence:async()=>({url,text:quotes[i]}),
      brain:{complete:async p=>p.prompt.includes('想不想再花')?{deep:true}:p.prompt.includes('页面证据')?{relevant:true,quote:quotes[i]}:p.prompt.includes('是否想把')?{interested:true}:p.prompt.includes('网页兴趣日记摘录')?{quote:quotes[i],thought:'我有点好奇。'}:p.prompt.includes('感想审查')?{safe:true}:{details:'摘要'}}});
  }
  assert.equal((await collectGeneratedWebJournal(dir,caps[0])).length,1, 'fixture must establish an interested journal');
  let prompt = '';
  await generateDailyDiary({dataDir:dir, force:true, webScope:caps[0], brain:{reply:async p => {prompt=p.text;return {text:'# 随笔\n今天挺安静。'};}}});
  assert.ok(prompt.includes(quotes[0]), 'trusted interested journal should reach diary model');
  assert.ok(!prompt.includes(quotes[1]), 'another owner must never reach diary model');
  assert.equal((await readScopedDiary({dataDir:dir,webScope:caps[0]})).content, '# 随笔\n今天挺安静。');
  const prompts=[];
  const item=await tiebaMessage({userId:1,text:'你的日记写了什么',id:901});
  await handleTurn({memory:{dir,touch(){}},brain:{reply:async p=>{prompts.push(p);return {text:''}}},bot:{},human:{},waker:{wake(){}}},[item],cfg('1'));
  assert.match(prompts[0].situation,/今天挺安静/);
  assert.equal(prompts[0].tools,false);
  for (const bad of [await tiebaMessage({userId:2,text:'你的日记写了什么',id:902}), await tiebaMessage({userId:1,type:'group',groupId:9,text:'你的日记写了什么',id:903}), {...item}]) {
    const captures=[];
    await handleTurn({memory:{dir,touch(){}},brain:{reply:async p=>{captures.push(p);return {text:''}}},bot:{},human:{},waker:{wake(){}}},[bad],cfg('1'));
    if (captures.length) assert.doesNotMatch(captures[0].situation,/今天挺安静/);
  }
  await generateDailyDiary({dataDir:dir,force:true,webScope:caps[1],brain:{reply:async()=>({text:'第二位主人的独立日记'})}});
  const secondPrompts=[];
  await handleTurn({memory:{dir,touch(){}},brain:{reply:async p=>{secondPrompts.push(p);return {text:''}}},bot:{},human:{},waker:{wake(){}}},[await tiebaMessage({userId:2,text:'你的日记写了什么',id:904})],cfg('2'));
  assert.match(secondPrompts[0].situation,/第二位主人的独立日记/);
  assert.doesNotMatch(secondPrompts[0].situation,/今天挺安静/);
  assert.deepEqual(listAllDiaries(dir), []);
  const script = `import {createWebScope} from './src/web-living.js'; import {readScopedDiary} from './src/diary-system.js'; const cfg=JSON.parse(process.argv[1]); const cap=createWebScope(cfg,cfg.dataDir); console.log(JSON.stringify(await readScopedDiary({dataDir:cfg.dataDir,webScope:cap})));`;
  const run = () => JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',script,JSON.stringify(cfg('1'))],{cwd:process.cwd(),encoding:'utf8'}));
  assert.equal(run().content,'# 随笔\n今天挺安静。');
  const scope=cfg('1').memoryBrain.trustedScope;
  const makeDeps=(answer,sendImpl,extra={})=>({memory:{dir,touch(){}},brain:{reply:async()=>({text:answer}),...extra},bot:{send:sendImpl,setTyping:async()=>{}},human:{say:async(parts,{send})=>{let count=0;for(const p of parts){const r=await send(p);if(!r?.ok)return {ok:false,sent:count};count++;}return {ok:true,sent:count,parts};}},waker:{wake(){}}});
  const sent=[];
  await handleTurn(makeDeps('鱼'.repeat(50),async(_k,m)=>{sent.push(m);return {ok:true,outcome:'confirmed'}}),[item],cfg('1'));
  assert.equal([...sent.join('')].length,50);
  sent.length=0;
  await handleTurn(makeDeps('鱼'.repeat(51),async(_k,m)=>{sent.push(m);return {ok:true,outcome:'confirmed'}},{rewriteConciseDraft:async()=>{throw Error('no rewrite')},regenerateConciseDraft:async()=>{throw Error('no regenerate')}}),[item],cfg('1'));
  assert.equal(sent.length,0);
  let calls=0;
  await handleTurn(makeDeps('第一句\n\n第二句',async()=>{calls++;return {ok:false,outcome:'unknown'}}),[item],cfg('1'));
  assert.equal(calls,1);
  const forgetScript = `import {createManagedMemoryBrain} from './src/memory-brain-trust.js'; const c=JSON.parse(process.argv[1]),s=c.memoryBrain.trustedScope; await createManagedMemoryBrain({directory:c.dataDir+'/memory-brain-scoped',scope:s,sources:['web-source-page'],trustedProcess:true,backend:'sqlite-fts'}).forget(s,{source:'web-source-page',evidence:'https://example.com/0'});`;
  let child;
  const raced=[];
  await handleTurn({memory:{dir,touch(){}},brain:{reply:async p=>{assert.match(p.situation,/今天挺安静/); child=spawn(process.execPath,['--input-type=module','-e',forgetScript,JSON.stringify(cfg('1'))],{cwd:process.cwd(),stdio:'ignore'}); return {text:'日记里的回答'};},rewriteConciseDraft:async()=>''},bot:{send:async(_k,m)=>{raced.push(m);return {ok:true,outcome:'confirmed'}},setTyping:async()=>{}},human:{say:async(parts,{send})=>{await new Promise((resolve,reject)=>{if(child.exitCode!==null)return child.exitCode===0?resolve():reject(Error('forget failed'));child.once('exit',code=>code===0?resolve():reject(Error('forget failed')))});for(const p of parts) await send(p);return {ok:true,sent:parts.length,parts};}},waker:{wake(){}}},[item],cfg('1'));
  assert.deepEqual(raced,[]);
  await createManagedMemoryBrain({directory:path.join(dir,'memory-brain-scoped'),scope,sources:['web-source-page'],trustedProcess:true,backend:'sqlite-fts'}).forget(scope,{source:'web-source-page',evidence:'https://example.com/0'});
  assert.equal(await readScopedDiary({dataDir:dir,webScope:caps[0]}),null);
  assert.equal(run(),null);
  let result = await generateDailyDiary({dataDir:dir,force:true,webScope:caps[1],brain:{reply:async()=>({text:'{"write":false}'})}});
  assert.equal(result.written,false);
  assert.equal((await readScopedDiary({dataDir:dir,webScope:caps[1]})).content,'第二位主人的独立日记');
  await assert.rejects(generateDailyDiary({dataDir:dir,force:true,webScope:caps[1],brain:{reply:async()=>{throw Error('offline')}}}),/offline/);
  assert.equal((await readScopedDiary({dataDir:dir,webScope:caps[1]})).content,'第二位主人的独立日记');

  // The model is deliberately paused while an independent process requests
  // forget against the real sqlite-fts ledger. Forget cannot overtake the
  // guarded model/commit, and after it completes the diary must be unreadable.
  const concurrentForget = `import {createManagedMemoryBrain} from './src/memory-brain-trust.js'; const c=JSON.parse(process.argv[1]),s=c.memoryBrain.trustedScope; const b=createManagedMemoryBrain({directory:c.dataDir+'/memory-brain-scoped',scope:s,sources:['web-source-page'],trustedProcess:true,backend:'sqlite-fts'}); process.send('ready'); await b.forget(s,{source:'web-source-page',evidence:'https://example.com/1'}); process.send('forgotten',()=>process.disconnect());`;
  let forgetting, exited, completion, didForget=false;
  const generated = await generateDailyDiary({dataDir:dir,force:true,webScope:caps[1],brain:{reply:async p=>{
    assert.ok(p.text.includes(quotes[1]));
    forgetting=spawn(process.execPath,['--input-type=module','-e',concurrentForget,JSON.stringify(cfg('2'))],{cwd:process.cwd(),stdio:['ignore','ignore','inherit','ipc']});
    t.after(()=>{if (forgetting.exitCode===null) forgetting.kill();});
    exited=new Promise((resolve,reject)=>{forgetting.once('error',reject);forgetting.once('exit',(code,signal)=>code===0?resolve():reject(Error(`forget failed: ${code} ${signal}`)));});
    completion=new Promise(resolve=>forgetting.on('message',message=>{if(message==='forgotten'){didForget=true;resolve();}}));
    await new Promise((resolve,reject)=>{forgetting.on('message',message=>{if(message==='ready')resolve();});forgetting.once('error',reject);});
    await new Promise(resolve=>setTimeout(resolve,300));
    assert.equal(didForget,false,'forget must wait for generation guard');
    return {text:'并发生成的私密日记'};
  }}});
  assert.equal(generated.written,true);
  await completion; await exited;
  assert.equal(await readScopedDiary({dataDir:dir,webScope:caps[1]}),null);
});
