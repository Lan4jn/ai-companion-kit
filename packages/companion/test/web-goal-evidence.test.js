import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { browseWebTopic } from '../src/web-living.js';
import { createGoalCore } from '../src/goal-core.js';

const temp = () => fs.mkdtempSync(path.join(process.env.TMPDIR || '/root/.hermes/cache/scratch', 'web-evidence-'));
const brain = { complete: async ({prompt}) => prompt.includes('想不想再花') ? {deep:true,why:'想了解'} : prompt.includes('提炼出') ? {learned:[]} : {details:'测试',mood:'测试'} };

test('unrelated results with a URL cannot complete a search goal', async () => {
 const dir = temp();
 let calls = 0;
 await browseWebTopic({ brain, memory:{dir}, topic:'怪物猎人荒野', search:async()=> ++calls === 1
   ? ({success:true,text:'1. 【怪物猎人荒野】\n怪物猎人荒野的相关资料\n(来源: web https://example.com/game)'})
   : ({success:true,text:'1. 【天气预报】\n北京天气晴朗\n(来源: web https://example.com/weather)'}) });
 const state = createGoalCore({file:path.join(dir,'web-goals.json')}).snapshot();
 assert.equal(Object.values(state.goals)[0].progress,0);
 assert.notEqual(Object.values(state.goals)[0].status,'completed');
});

test('a desire cannot complete against a failed linked goal', () => {
 const core = createGoalCore({file:path.join(temp(),'goals.json')});
 core.addGoal({id:'g',title:'g',target:1});
 core.addDesire({id:'d',title:'d',goalId:'g'});
 core.record({id:'fail',type:'goal.failed',goalId:'g',reason:'failed'});
 assert.throws(()=>core.record({id:'done',type:'desire.completed',desireId:'d',amount:1,evidence:{source:'s',ref:'r'}}),/closed/);
 assert.equal(core.snapshot().desires.d.status,'active');
});

test('a failed goal cannot be resurrected by progress', () => {
 const core = createGoalCore({file:path.join(temp(),'goals.json')});
 core.addGoal({id:'g',title:'g',target:1});
 core.record({id:'fail',type:'goal.failed',goalId:'g',reason:'failed'});
 assert.throws(()=>core.record({id:'p',type:'goal.progress',goalId:'g',amount:1,evidence:{source:'s',ref:'r'}}),/closed/);
 assert.equal(core.snapshot().goals.g.status,'failed');
});
