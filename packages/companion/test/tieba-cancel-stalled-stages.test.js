import test from 'node:test';
import assert from 'node:assert/strict';
import {createTiebaLoginIntegration} from '../src/tieba-login-integration.js';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}};
const tick=()=>new Promise(r=>setImmediate(r));
const bounded=p=>Promise.race([p,new Promise((_,reject)=>setTimeout(()=>reject(Error('cancel hung')),150))]);
const mkSession=(close)=>({context:{cookies:async()=>[]},close});
const mkTransport=(close)=>({fetchBody:async()=>{},close});
const opts={listSource:{list:async()=>[]},verifyIdentity:async()=>({state:'online',subject:'user'})};

test('cancel while session creation hangs closes a late session once',async()=>{
 const gate=deferred();let closes=0;
 const app=createTiebaLoginIntegration({...opts,createSession:()=>gate.promise});
 const started=app.provider.start();await tick();
 await bounded(app.provider.cancel());assert.deepEqual(await bounded(started),{state:'unknown'});
 gate.resolve(mkSession(()=>{closes++}));await tick();await tick();assert.equal(closes,1);await app.close();
});
test('cancel during transport creation disposes late transport without reviving session',async()=>{
 const gate=deferred();let sc=0,tc=0;
 const app=createTiebaLoginIntegration({...opts,createSession:async()=>mkSession(()=>{sc++}),createTransport:()=>gate.promise});
 const started=app.provider.start();await tick();await bounded(app.provider.cancel());assert.deepEqual(await bounded(started),{state:'unknown'});
 gate.resolve(mkTransport(()=>{tc++}));await tick();await tick();assert.equal(sc,1);assert.equal(tc,1);assert.deepEqual(await app.provider.status(),{state:'unknown'});await app.close();
});
test('cancel interrupts stalled refresh and rejects late verification',async()=>{
 const gate=deferred();let calls=0,sc=0,tc=0;
 const app=createTiebaLoginIntegration({...opts,createSession:async()=>mkSession(()=>{sc++}),createTransport:async()=>mkTransport(()=>{tc++}),verifyIdentity:()=>++calls===1?{state:'online',subject:'user'}:gate.promise});
 assert.deepEqual(await app.provider.start(),{state:'online'});const status=app.provider.status();await tick();await bounded(app.provider.cancel());assert.deepEqual(await bounded(status),{state:'unknown'});gate.resolve({state:'online',subject:'user'});await tick();assert.equal(sc,1);assert.equal(tc,1);await app.close();
});
