import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {sendReservedReply} from '../src/bili-comment-send.js';
import {reconcileComment} from '../src/bili-comment-reconcile.js';

const childScript = `
import fs from 'node:fs';
import {reconcileComment} from './src/bili-comment-reconcile.js';
const [dir,endpoint,stage]=process.argv.slice(1);
let active=false, tempFd=-1, linked=false;
function stop(point){if(stage===point){process.stdout.write('WINDOW '+point+'\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}}
const open=fs.openSync, write=fs.writeFileSync, sync=fs.fsyncSync, link=fs.linkSync, unlink=fs.unlinkSync, close=fs.closeSync;
fs.closeSync=function(fd){if(fd===tempFd)tempFd=-1;return close.call(this,fd)};
fs.openSync=function(p,...a){if(typeof p==='string' && /\\.tmp$/.test(p)){active=true;stop('before-open');const fd=open.call(this,p,...a);tempFd=fd;stop('after-open');return fd;}return open.call(this,p,...a)};
fs.writeFileSync=function(p,...a){if(p===tempFd){stop('before-write');const r=write.call(this,p,...a);stop('after-write');return r;}return write.call(this,p,...a)};
fs.fsyncSync=function(fd){if(fd===tempFd){stop('before-file-sync');const r=sync.call(this,fd);stop('after-file-sync');return r;}if(active&&linked){stop('before-dir-sync');const r=sync.call(this,fd);stop('after-dir-sync');return r;}return sync.call(this,fd)};
fs.linkSync=function(a,b){stop('before-link');const r=link.call(this,a,b);linked=true;stop('after-link');return r};
fs.unlinkSync=function(p){if(active)stop('before-unlink');const r=unlink.call(this,p);if(active)stop('after-unlink');return r};
const result=await reconcileComment({account:'123',aid:'789',root:'456',rpid:'999',ledgerDir:dir,testEndpoint:endpoint});
if(stage==='none' && result.status!=='confirmed')process.exitCode=2;
console.log('MISSED');
`;

const windows=['before-open','after-open','before-write','after-write','before-file-sync','after-file-sync','before-link','after-link','before-dir-sync','after-dir-sync','before-unlink','after-unlink'];
for(const stage of windows) test(`SIGKILL confirmation publication: ${stage}`,async t=>{
 const base=path.resolve('.test-tmp');fs.mkdirSync(base,{recursive:true});const dir=fs.mkdtempSync(path.join(base,'bili-crash-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const item={rpid_str:'999',oid:789,type:1,mid:123,root:456,parent:456,state:0,ctime:Math.floor(Date.now()/1000),content:{message:'synthetic'}};
 let posts=0;const server=http.createServer((req,res)=>{item.ctime=Math.floor(Date.now()/1000);if(req.method==='POST')posts++;res.setHeader('content-type','application/json');res.end(JSON.stringify(req.method==='POST'?{code:0,data:{rpid_str:'999',reply:item}}:{code:0,data:{page:{num:1,size:20,count:1},replies:[item]}}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const endpoint=`http://127.0.0.1:${server.address().port}`, args={account:'123',aid:'789',root:'456',message:'synthetic',headers:{cookie:'DedeUserID=123; bili_jct=test'},ledgerDir:dir,testEndpoint:endpoint};
 assert.equal((await sendReservedReply(args)).ok,true);
 const key=fs.readdirSync(dir).find(x=>/^[a-f0-9]{64}\.json$/.test(x)).slice(0,64);const original=fs.readFileSync(path.join(dir,key+'.json'),'utf8');const receipt=fs.readFileSync(path.join(dir,key+'.receipt.json'),'utf8');
 const p=spawn(process.execPath,['--input-type=module','-e',childScript,dir,endpoint,stage],{cwd:process.cwd(),stdio:['ignore','pipe','pipe']});
 let err='';p.stderr.on('data',x=>err+=x);const exited=new Promise(r=>p.once('exit',(code,signal)=>r({code,signal})));
 await Promise.race([new Promise((resolve,reject)=>{let out='';p.stdout.on('data',x=>{out+=x;if(out.includes('WINDOW '+stage))resolve();if(out.includes('MISSED'))reject(Error('window not reached'));});p.once('exit',()=>reject(Error('child exited early '+err)));}),new Promise((_,reject)=>setTimeout(()=>reject(Error('window timeout '+err)),5000).unref())]);
 p.kill('SIGKILL');assert.equal((await exited).signal,'SIGKILL');
 assert.equal(fs.readFileSync(path.join(dir,key+'.json'),'utf8'),original);assert.equal(fs.readFileSync(path.join(dir,key+'.receipt.json'),'utf8'),receipt);
 const confirmed=path.join(dir,key+'.confirmed.json');const temps=fs.readdirSync(dir).filter(x=>/^\..*\.tmp$/.test(x));
 assert.equal(temps.length,['before-open','after-unlink'].includes(stage)?0:1);
 if(fs.existsSync(confirmed)){const c=JSON.parse(fs.readFileSync(confirmed,'utf8'));assert.equal(c.status,'confirmed');assert.equal(c.rpid,'999');}
 assert.equal((await sendReservedReply(args)).code,'comment_already_reserved');assert.equal(posts,1);
 if(stage==='before-link'){
  const children=Array.from({length:6},()=>spawn(process.execPath,['--input-type=module','-e',childScript,dir,endpoint,'none'],{cwd:process.cwd(),stdio:'ignore'}));
  const exits=await Promise.all(children.map(c=>new Promise(r=>c.once('exit',(code,signal)=>r({code,signal})))));assert.ok(exits.every(x=>x.code===0&&!x.signal));
 }
 assert.equal((await reconcileComment({...args,rpid:'999'})).status,'confirmed');assert.equal(JSON.parse(fs.readFileSync(confirmed)).status,'confirmed');
 assert.equal((await reconcileComment({...args,account:'124',rpid:'999'})).status,'unknown');assert.equal((await reconcileComment({...args,aid:'790',rpid:'999'})).status,'unknown');assert.equal((await reconcileComment({...args,root:'457',rpid:'999'})).status,'unknown');assert.equal(posts,1);
});
