import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {reserveComment} from '../src/bili-comment-ledger.js';
import {reconcileComment} from '../src/bili-comment-reconcile.js';

async function scenario(make,root='') {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'ledger-reconcile-'));process.env.BILI_COMMENT_LEDGER_DIR=dir;
 const target={account:'123',aid:'789',root,message:'synthetic text'};
 assert.equal(reserveComment(target).ok,true);
 const entry=JSON.parse(fs.readFileSync(path.join(dir,fs.readdirSync(dir)[0])));
 const base={rpid_str:'999',oid:789,type:1,mid:123,root:root?Number(root):0,parent:root?Number(root):0,state:0,ctime:Math.floor(Date.now()/1000),content:{message:'synthetic text'}};
 const server=http.createServer((req,res)=>{assert.equal(req.headers.cookie,undefined);res.setHeader('content-type','application/json');res.end(JSON.stringify(make(base)));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try {const result=await reconcileComment({account:'123',aid:'789',root,rpid:'999',ledgerDir:dir,testEndpoint:`http://127.0.0.1:${server.address().port}`});assert.equal(reserveComment({...target,message:'different'}).code,'comment_already_reserved');assert.equal(entry.status,'unknown');return {result,files:fs.readdirSync(dir)};} finally {server.close();fs.rmSync(dir,{recursive:true,force:true});}
}
const page=replies=>({code:0,data:{page:{num:1,size:20,count:replies.length},replies}});
test('matching public evidence without causal proof stays unknown',async()=>{const x=await scenario(b=>page([b]));assert.equal(x.result.code,'causal_evidence_missing');assert.equal(x.files.length,1);});
test('matching reply without causal proof stays unknown',async()=>{assert.equal((await scenario(b=>page([b]),'456')).result.status,'unknown');});
for(const [label,make] of [
 ['ambiguous',b=>page([b,{...b,rpid_str:'1000'}])],
 ['wrong account',b=>page([{...b,mid:124}])],
 ['wrong video',b=>page([{...b,oid:790}])],
 ['wrong parent',b=>page([{...b,parent:1}])],
 ['hidden',b=>page([{...b,state:2}])],
 ['wrong text',b=>page([{...b,content:{message:'other'}}])],
 ['old',b=>page([{...b,ctime:b.ctime-100}])],
 ['incomplete',b=>({code:0,data:{page:{num:1,size:20,count:2},replies:[b]}})],
 ['error',()=>({code:-412})],
]) test(label+' stays unknown',async()=>{const x=await scenario(make);assert.equal(x.result.status,'unknown');assert.equal(x.files.length,1);});
