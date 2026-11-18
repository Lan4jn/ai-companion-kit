import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';

const cli = new URL('../scripts/chat-durable-offline.mjs', import.meta.url).pathname;
const journal = new URL('../src/chat-durable-journal-candidate.js', import.meta.url).href;
function inspect(dir) { return spawnSync(process.execPath,[cli,'inspect-lock','--directory',dir],{encoding:'utf8'}); }
test('diagnoses live and crashed journal locks without removing either', async t => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'chat-lock-diagnostic-')); fs.chmodSync(dir,0o700);
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const code=`import {EncryptedChatJournal} from ${JSON.stringify(journal)}; new EncryptedChatJournal({directory:process.argv[1],key:Buffer.alloc(32)}); console.log('ready'); setInterval(()=>{},1000);`;
 const child=spawn(process.execPath,['--input-type=module','-e',code,dir],{stdio:['ignore','pipe','pipe']});
 t.after(()=>{if(child.exitCode===null && child.signalCode===null) child.kill('SIGKILL');});
 await once(child.stdout,'data');
 for (const phase of ['live','crashed']) {
  if(phase==='crashed'){child.kill('SIGKILL');await once(child,'exit');}
  const result=inspect(dir); assert.equal(result.status,0,result.stderr);
  const report=JSON.parse(result.stdout); assert.equal(report.status,'owner-unknown'); assert.equal(report.removed,false); assert.equal(report.lock.inode,String(fs.lstatSync(path.join(dir,'.journal.lock'),{bigint:true}).ino));
  assert.equal(fs.existsSync(path.join(dir,'.journal.lock')),true);
 }
});
test('rejects symlink and nonempty unknown lock',t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'chat-lock-unsafe-'));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const lock=path.join(dir,'.journal.lock');fs.symlinkSync(dir,lock);assert.notEqual(inspect(dir).status,0);fs.unlinkSync(lock);
 fs.mkdirSync(lock,{mode:0o700});fs.writeFileSync(path.join(lock,'unknown'),'x');assert.notEqual(inspect(dir).status,0);assert.equal(fs.existsSync(path.join(lock,'unknown')),true);
});
