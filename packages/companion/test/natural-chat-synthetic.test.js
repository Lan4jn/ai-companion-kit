import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {handleTurn} from '../src/index.js';
import {Memory} from '../src/memory.js';
import {Brain} from '../src/brain.js';
import {Role} from '../src/role.js';
import {Humanizer} from '../src/humanize.js';
import {loopGuard} from '../src/loop-guard.js';
import {tiebaMessage} from './tieba-trusted-message-fixture.js';

function answer(content){const body={choices:[{message:{content},finish_reason:'stop'}]};return {ok:true,status:200,text:async()=>JSON.stringify(body),json:async()=>body};}
for (const scenario of [
 {input:'今天上班好累',reply:'辛苦啦，今晚早点歇歇'},
 {input:'今天不想说话',reply:'好，你先休息'},
 {input:'这事我不同意',reply:'我不太赞成'},
 {input:'新游戏出了你玩过吗',reply:'我还不知道，得先查查'},
 {input:'你好',reply:'你好呀'.repeat(18), rewrite:'你好呀'},
 {input:'你好呀',reply:'长'.repeat(51), rewrite:''},
]) test(`isolated real turn: ${scenario.input} / ${scenario.rewrite === ''?'silent':scenario.rewrite?'rewrite':'direct'}`,async t=>{
 loopGuard.state.clear();const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'natural-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const card=path.join(dir,'role.md');fs.writeFileSync(card,'合成角色卡：小鱼，喜欢游戏，温和自然；不编造自己没经历的事情。');
 const memory=new Memory({dir});const brain=new Brain({apiKey:'synthetic',baseUrl:'http://invalid.local',model:'fixture',role:new Role({cardPath:card}),memory,dataDir:dir,ownerIds:['1']});
 const captured=[];t.mock.method(globalThis,'fetch',async(_u,o)=>{const p=JSON.parse(o.body);captured.push(p);const sys=p.messages[0].content;
  if(sys.includes('你只重新斟酌'))return answer(scenario.rewrite || '');
  if(sys.includes('根据本轮上下文与已取得的工具结果'))return answer('长'.repeat(51));
  if(sys.includes('你是独立审校员'))return answer('PASS');
  assert.match(JSON.stringify(p.messages),/合成角色卡/);assert.match(JSON.stringify(p.messages),/不无故赶人/);return answer(scenario.reply);
 });
 const sends=[];const bot={send:async(_k,m)=>{sends.push(m);return {ok:true}},setTyping:async()=>{}};
 await handleTurn({brain,memory,bot,human:new Humanizer({enabled:false}),waker:{wake(){}}},[await tiebaMessage({text:scenario.input})],{ownerIds:['1'],dataDir:dir});
 assert.ok(sends.length<=3);assert.ok(Array.from(sends.map(String).join('')).length<=50);
 if(scenario.rewrite==='')assert.equal(sends.length,0);else assert.equal(sends.map(String).join(''),scenario.rewrite||scenario.reply);
 assert.ok(captured.length);
});
