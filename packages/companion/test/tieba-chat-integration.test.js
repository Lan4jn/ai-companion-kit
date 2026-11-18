import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {handleTurn} from '../src/index.js';
import {tiebaMessage} from './tieba-trusted-message-fixture.js';

test('owner private batch injects source-labeled interest, not mixed or group',async t=>{
 const dir=await mkdtemp(path.join(process.env.TMPDIR,'tieba-chat-')); t.after(()=>rm(dir,{recursive:true,force:true}));
 await writeFile(path.join(dir,'tieba-interest.jsonl'),JSON.stringify({version:3,forum:'肥鱼避难所吧',url:'https://tieba.baidu.com/p/123',keywords:[],excerpt:'星露谷物语，喜欢在冬天整理农场',capturedAt:new Date().toISOString()})+'\n');
 async function turn(items){let captured;await handleTurn({brain:{reply:async p=>{captured=p;return {text:''}}},memory:{dir},bot:{},human:{},waker:{}},items,{ownerIds:['1'],dataDir:dir,tieba:{enabled:true}});return captured.situation;}
 const item=await tiebaMessage();
 assert.doesNotMatch(await turn([{...item}]),/星露谷物语，喜欢在冬天整理农场/);
 assert.match(await turn([item]),/星露谷物语，喜欢在冬天整理农场/);
 assert.doesNotMatch(await turn([await tiebaMessage({type:'group',groupId:9})]),/星露谷物语，喜欢在冬天整理农场/);
 assert.doesNotMatch(await turn([await tiebaMessage({userId:2}),item]),/星露谷物语，喜欢在冬天整理农场/);
});
