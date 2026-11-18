import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {sendReservedReply} from '../src/bili-comment-send.js';
import {reconcileComment} from '../src/bili-comment-reconcile.js';

 test('captured send receipt and public verification confirm without permitting resend', async () => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'bili-receipt-'));
 const item={rpid_str:'999',oid:789,type:1,mid:123,root:456,parent:456,state:0,ctime:Math.floor(Date.now()/1000),content:{message:'synthetic'}};
 const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(req.method==='POST'?{code:0,data:{rpid_str:'999',reply:item}}:{code:0,data:{page:{num:1,size:20,count:1},replies:[item]}}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const endpoint=`http://127.0.0.1:${server.address().port}`;
 try {
  const args={account:'123',aid:'789',root:'456',message:'synthetic',headers:{cookie:'DedeUserID=123; bili_jct=test'},ledgerDir:dir,testEndpoint:endpoint};
  assert.equal((await sendReservedReply(args)).ok,true);
  const receiptPath=path.join(dir,fs.readdirSync(dir).find(x=>x.endsWith('.receipt.json')));
  const receipt=fs.readFileSync(receiptPath,'utf8');
  fs.writeFileSync(receiptPath,JSON.stringify({...JSON.parse(receipt),rpid:'998'}));
  assert.equal((await reconcileComment({account:'123',aid:'789',root:'456',rpid:'999',ledgerDir:dir,testEndpoint:endpoint})).status,'unknown');
  fs.writeFileSync(receiptPath,receipt);
  const attempts=await Promise.all(Array.from({length:8},()=>reconcileComment({account:'123',aid:'789',root:'456',rpid:'999',ledgerDir:dir,testEndpoint:endpoint})));
  assert.ok(attempts.every(x=>x.status==='confirmed'));
  const result=await reconcileComment({account:'123',aid:'789',root:'456',rpid:'999',ledgerDir:dir,testEndpoint:endpoint});
  assert.equal(result.status,'confirmed');
  assert.equal((await sendReservedReply(args)).code,'comment_already_reserved');
 } finally {await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});

for (const kind of ['wrong-account','wrong-video','wrong-rpid','missing-id','http-error','hidden-public']) test(kind+' remains blocked unknown',async()=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'bili-invalid-'));
 const base={rpid_str:'999',oid:789,type:1,mid:123,root:456,parent:456,state:0,ctime:Math.floor(Date.now()/1000),content:{message:'synthetic'}};
 const reply={...base,...(kind==='wrong-account'?{mid:124}:{}),...(kind==='wrong-video'?{oid:790}:{}),...(kind==='wrong-rpid'?{rpid_str:'998'}:{})};
 let count=0;
 const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');if(req.method==='POST'){count++;if(kind==='http-error')res.statusCode=500;res.end(JSON.stringify({code:0,data:{...(kind==='missing-id'?{}:{rpid_str:'999'}),reply}}));}else res.end(JSON.stringify({code:0,data:{page:{num:1,size:20,count:1},replies:[{...base,state:kind==='hidden-public'?2:0}]}}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const endpoint=`http://127.0.0.1:${server.address().port}`;
 try {const a={account:'123',aid:'789',root:'456',message:'synthetic',headers:{cookie:'DedeUserID=123; bili_jct=test'},ledgerDir:dir,testEndpoint:endpoint};await sendReservedReply(a);
 assert.equal((await reconcileComment({...a,rpid:'999'})).status,'unknown');
 assert.equal((await sendReservedReply(a)).code,'comment_already_reserved');assert.equal(count,1);
 }finally{await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});
