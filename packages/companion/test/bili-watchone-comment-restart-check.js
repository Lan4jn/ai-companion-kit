import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';import assert from 'node:assert/strict';import {spawn,execFileSync} from 'node:child_process';
const root=fs.mkdtempSync('/root/.hermes/cache/scratch/bc-');const home=path.join(root,'home');fs.mkdirSync(home);const video=path.join(root,'clip.webm');
const requests=[];const server=http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{requests.push(JSON.parse(b));res.socket.destroy()})});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
try {
 execFileSync('ffmpeg',['-loglevel','error','-f','lavfi','-i','color=black:s=32x32:r=10:d=3','-c:v','libvpx','-an',video]);
 fs.writeFileSync(path.join(home,'not-a-directory'),'x');
 async function run(account,aid,bvid,mode,expectedCount){
  const args=['test/bili-watchone-comment-restart-fixture.js',home,String(port),account,String(aid),bvid,mode,video];
  const out=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,args,{cwd:process.cwd(),env:{PATH:process.env.PATH,HOME:home,TMPDIR:root,CHROME_PATH:process.env.CHROME_PATH||'/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome'}});let s='';child.stdout.on('data',c=>s+=c);child.stderr.on('data',c=>s+=c);child.on('error',reject);child.on('close',code=>code===0?resolve(s):reject(Error(`child ${code}: ${s}`)));});
  assert.match(out,/FIXTURE_RESULT .*"full":true/);assert.equal(out.includes('FIXTURE_COMMENT_PAGE_OPEN'),!['long','privacy'].includes(mode));assert.equal(requests.length,expectedCount,`${account} ${aid} ${mode}: ${out}`);console.log(`PASS account=${account} aid=${aid} mode=${mode} total_received=${requests.length}\n${out}`);
 }
 await run('1001',101,'BV1234567890','normal',1);
 const records=fs.readdirSync(path.join(home,'.bili-ai','comment-ledger')).map(f=>JSON.parse(fs.readFileSync(path.join(home,'.bili-ai','comment-ledger',f))));assert.equal(records.length,1);assert.equal(records[0].status,'unknown');assert.equal(records[0].account,'1001');assert.equal(records[0].aid,'101');
 await run('1001',101,'BV1234567890','normal',1);
 await run('1002',101,'BV1234567890','normal',2);
 await run('1001',102,'BV1234567891','normal',3);
 await run('1001',103,'BV1234567892','long',3);
 await run('1001',104,'BV1234567893','privacy',3);
 await run('1001',105,'BV1234567894','ledgerfail',3);
 assert.deepEqual(requests.map(x=>[x.account,x.aid]),[['1001','101'],['1002','101'],['1001','102']]);
 console.log('ALL PASS: full watch / accepted-then-response-lost / independent restart / identity / length / privacy / ledger failure');
} finally {server.close();fs.rmSync(root,{recursive:true,force:true})}
