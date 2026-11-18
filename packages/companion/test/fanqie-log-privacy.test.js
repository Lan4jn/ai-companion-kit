import test from 'node:test';
import assert from 'node:assert/strict';
import { createFanqieIntegration } from '../src/fanqie-integration.js';

test('goal errors cannot leak private model content to logs', async () => {
 const logs=[]; const old=console.warn; console.warn=(...x)=>logs.push(x);
 try {
  const app=createFanqieIntegration({serial:'test',memoryDir:'/unused',want:async()=>true,brain:{complete:async()=>{throw Error('秘密正文与书名')}},goalCore:{},mutex:{tryBackground:async f=>{await f();return true}},online:async()=>true,navigate:async()=>({ok:true,bookTitle:'秘密书名'}),progress:async()=>null});
  await app.run();
 } finally { console.warn=old; }
 assert.ok(logs.length); assert.ok(!JSON.stringify(logs).includes('秘密'));
});
