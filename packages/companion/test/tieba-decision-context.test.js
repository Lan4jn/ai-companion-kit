import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setupProductionTieba } from '../src/index.js';

test('production decision receives grounded bounded context, refuses without browsing and excludes private material', async t => {
 const dir = await mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'tieba-context-'));
 t.after(() => rm(dir, {recursive:true, force:true}));
 const now = new Date();
 const day = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
 await writeFile(path.join(dir, 'tieba-interest.jsonl'), JSON.stringify({version:3,forum:'肥鱼避难所吧',url:'https://tieba.baidu.com/p/123',capturedAt:now.toISOString(),keywords:['猫咪','私聊SECRET'],excerpt:'私聊SECRET'})+'\n');
 await writeFile(path.join(dir, 'mood.json'), JSON.stringify({[day]:{key:'bored',reason:'私聊SECRET'}}));
 await writeFile(path.join(dir, 'goals-desires.json'), JSON.stringify({activeDesires:{idle:{title:'想玩游戏 私聊SECRET'},dm_owner:{title:'私聊SECRET'}}}));
 let captured, scheduler, reads = 0;
 const h = setupProductionTieba({cfg:{tieba:{enabled:true},dataDir:dir},brain:{complete:async p=>{captured=p; return '{"browse":false}';}},makeSource:()=>({list:async()=>{reads++;return []},read:async()=>{reads++;}}),makeScheduler:opts=>{scheduler=opts; return {start(){},stop(){}};}});
 const {createTiebaScheduler} = await import('../src/tieba-scheduler.js');
 const s = createTiebaScheduler(scheduler);
 assert.equal((await s.tick()).status,'declined');
 assert.equal(reads,0);
 assert.match(captured.prompt,/猫咪/); assert.match(captured.prompt,/游戏/); assert.match(captured.prompt,/无聊/);
 assert.match(captured.prompt,/当前时间/); assert.match(captured.prompt,/最近.*贴吧/);
 assert.doesNotMatch(captured.prompt,/SECRET|私聊|https:\/\//);
 await h.stop();
});
