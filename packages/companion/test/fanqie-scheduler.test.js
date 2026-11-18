import {test} from 'node:test';import assert from 'node:assert/strict';import {createReadingScheduler} from '../src/fanqie-scheduler.js';
test('拒绝启动时不读取和翻页',async()=>{let n=0;const s=createReadingScheduler({want:async()=>false,run:async()=>n++});assert.equal((await s.tick()).reason,'not-interested');assert.equal(n,0)});
test('在忙时不可重入',async()=>{let release;const wait=new Promise(r=>release=r);let n=0;const s=createReadingScheduler({want:async()=>true,run:async()=>{n++;await wait}});let first=s.tick();await new Promise(r=>setImmediate(r));assert.equal((await s.tick()).reason,'busy');release();await first;assert.equal(n,1)});


test('定时日志只输出安全状态，不输出运行内容或错误', async () => {
  const events = [];
  const oldLog = console.log, oldWarn = console.warn;
  console.log = (...args) => events.push(args);
  console.warn = (...args) => events.push(args);
  const results = [
    {ok:true, title:'秘密书名', text:'私密正文'},
    {ok:false, reason:'busy', error:'秘密异常'},
    {ok:false, reason:'秘密未知原因'},
    new Error('秘密抛出异常'),
  ];
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const scheduler = createReadingScheduler({intervalMs:1, want:async()=>true, run:async()=>{
    const value = results.shift();
    if (!results.length) setImmediate(resolveDone);
    if (value instanceof Error) throw value;
    return value;
  }});
  try {
    scheduler.start();
    await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error('scheduler timeout')), 1000))]);
  } finally {
    scheduler.stop();
    console.log = oldLog; console.warn = oldWarn;
  }
  assert.deepEqual(events.map(args => args.slice(1)), [['success'], ['busy'], ['failed'], ['error']]);
  assert.ok(!JSON.stringify(events).includes('秘密'));
});
