import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {Brain} from '../src/brain.js';

test('unauthenticated panel chat does not load or recall QQ private turns',async t=>{
 const root=path.resolve(import.meta.dirname,'..'),dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'panel-private-isolated-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 fs.mkdirSync(path.join(dir,'scripts'));fs.mkdirSync(path.join(dir,'data'));
 fs.cpSync(path.join(root,'scripts/panel.mjs'),path.join(dir,'scripts/panel.mjs'));fs.cpSync(path.join(root,'src'),path.join(dir,'src'),{recursive:true});
 fs.writeFileSync(path.join(dir,'package.json'),'{"type":"module"}');fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({ownerIds:['11111']}));
 const seen=[]; const memory={sessionTurns:k=>{seen.push(k);return k==='private:11111'?[{text:'QQ_HISTORY_SECRET'}]:[]},recallTurns:(_q,{where})=>where==='private:11111'?[{text:'QQ_RECALL_SECRET'}]:[],remember:()=>{},logTurn:()=>{},recallBiliFeelings:()=> 'QQ_FEELING_SECRET'};
 const requests=[];t.mock.method(globalThis,'fetch',async (_url,options)=>{requests.push(JSON.parse(options.body));return {ok:true,text:async()=>JSON.stringify({choices:[{message:{content:'好的'}}]})}});
 const brain=new Brain({apiKey:'synthetic',ownerIds:['11111'],memory,role:{build:({situation})=>situation},dataDir:dir});
 const {handlePanelRequest}=await import(pathToFileURL(path.join(dir,'scripts/panel.mjs')).href);
 const server=http.createServer((req,res)=>handlePanelRequest(req,res,{brain}));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const response=await new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/panel/api/chat/send',method:'POST',headers:{'content-type':'application/json'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode))});req.on('error',reject);req.end(JSON.stringify({text:'你好',key:'private:11111',userId:'11111'}))});
 assert.equal(response,200);assert.ok(!seen.includes('private:11111'));
 assert.doesNotMatch(JSON.stringify(requests),/QQ_HISTORY_SECRET|QQ_RECALL_SECRET|QQ_FEELING_SECRET/);
});
