import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createCandidateBroker} from '../src/douyin-request-broker-candidate.js';

test('broker default denies before DNS and invalid policy fails closed', async () => {
 let calls=0;
 const broker=createCandidateBroker({token:'a'.repeat(64),transportOptions:{lookup:async()=>{calls++;throw Error('must not resolve');}}});
 try {
  await new Promise(r=>broker.server.listen(0,'127.0.0.1',r));
  const status=await new Promise((resolve,reject)=>{
   const req=http.request({host:'127.0.0.1',port:broker.server.address().port,path:'/request',method:'POST',headers:{authorization:'Bearer '+'a'.repeat(64)}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
   req.on('error',reject);req.end(JSON.stringify({url:'https://www.douyin.com/',method:'GET',headers:{}}));
  });
  assert.equal(status,403);assert.equal(calls,0);
  assert.throws(()=>createCandidateBroker({token:'a'.repeat(64),policy:{hosts:['evil'],routes:[]}}));
 } finally {await broker.close();}
});
