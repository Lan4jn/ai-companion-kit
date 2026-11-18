import {test} from 'node:test';
import assert from 'node:assert/strict';
import {performObservedAction} from '../src/phone-observed-action.js';

test('只有观察、决策和操作后验证全部成功才报告成功', async () => {
 const events=[]; let count=0;
 const r=await performObservedAction({observe:async()=>{events.push('observe'); return {foreground:'launcher', text: ++count===1?'开始':'完成'}}, decide:async()=>{events.push('decide');return {type:'tap',x:0.5,y:0.5}}, act:async()=>{events.push('act');return true}});
 assert.equal(r.ok,true);assert.deepEqual(events,['observe','decide','act','observe']);
});
test('没有可验证屏幕时不能执行动作',async()=>{
 let called=false; const r=await performObservedAction({observe:async()=>null,decide:async()=>{called=true},act:async()=>true}); assert.equal(r.ok,false);assert.equal(called,false);
});
