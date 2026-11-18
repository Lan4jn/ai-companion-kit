import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {pathToFileURL} from 'node:url';

test('panel chat accepts private text in JSON body, not URL', async t => {
  const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'panel-private-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const root=path.resolve(import.meta.dirname,'..');
  fs.mkdirSync(path.join(dir,'scripts')); fs.mkdirSync(path.join(dir,'data'));
  fs.cpSync(path.join(root,'scripts/panel.mjs'),path.join(dir,'scripts/panel.mjs'));
  fs.cpSync(path.join(root,'src'),path.join(dir,'src'),{recursive:true});
  fs.writeFileSync(path.join(dir,'package.json'),'{"type":"module"}');
  fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({ownerIds:['11111']}));
  const before=new Map(['uncaughtException','unhandledRejection','SIGTERM'].map(e=>[e,new Set(process.listeners(e))]));
  const {handlePanelRequest}=await import(pathToFileURL(path.join(dir,'scripts/panel.mjs')).href);
  for(const [e,old] of before) for(const fn of process.listeners(e)) if(!old.has(fn)) process.removeListener(e,fn);
  const calls=[]; const server=http.createServer((req,res)=>handlePanelRequest(req,res,{brain:{reply:async i=>{calls.push(i);return {text:'fixture response'};}}}));
  await new Promise(r=>server.listen(0,'127.0.0.1',r)); t.after(()=>server.close());
  const origin=`http://127.0.0.1:${server.address().port}`;
  const r=await fetch(origin+'/panel/api/chat/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'synthetic secret'})});
  assert.equal(r.status,200); assert.equal(calls[0].text,'synthetic secret');
  const legacy=await fetch(origin+'/panel/api/chat/send?text=secret',{method:'POST'});
  assert.equal(legacy.status,400); assert.equal(calls.length,1);
});
