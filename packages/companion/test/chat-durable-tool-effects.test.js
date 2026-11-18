import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {EncryptedChatJournal} from '../src/chat-durable-journal-candidate.js';
import * as effects from '../src/chat-durable-tool-effects.js';

test('a completed tool is replayed from durable result without executing again', async t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tool-effects-'));
 const key=Buffer.alloc(32,7); let journal=new EncryptedChatJournal({directory:dir,key}); t.after(()=>{journal.close();fs.rmSync(dir,{recursive:true,force:true});});
 let count=0; const tools={send:async ({text})=>{count++;return {status:'completed',result:{accepted:text}}}};
 let log=effects.createDurableToolEffects({enabled:true,journal,tools});
 const call={session:'s',turn:'t',call:'0',tool:'send',args:{text:'hello'}};
 assert.deepEqual(await log.execute(call),{accepted:'hello'});
 journal.close(); journal=new EncryptedChatJournal({directory:dir,key});
 log=effects.createDurableToolEffects({enabled:true,journal,tools});
 assert.deepEqual(await log.execute(call),{accepted:'hello'}); assert.equal(count,1);
 await assert.rejects(log.execute({...call,args:{text:'changed'}}),/mismatch/); assert.equal(count,1);
});

test('process death after effect permanently blocks same session on reopen', async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tool-crash-')); const marker=path.join(dir,'effect');
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const journalUrl=new URL('../src/chat-durable-journal-candidate.js',import.meta.url).href;
 const toolUrl=new URL('../src/chat-durable-tool-effects.js',import.meta.url).href;
 const code=`import fs from 'node:fs'; import {EncryptedChatJournal} from ${JSON.stringify(journalUrl)}; import {createDurableToolEffects} from ${JSON.stringify(toolUrl)};
 const journal=new EncryptedChatJournal({directory:process.argv[1],key:Buffer.alloc(32,8)});
 const log=createDurableToolEffects({enabled:true,journal,tools:{send:async()=>{fs.writeFileSync(process.argv[2],'once'); process.exit(29)}}});
 await log.execute({session:'s',turn:'t',call:'0',tool:'send',args:{}});`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',code,dir,marker],{encoding:'utf8'});
 assert.equal(child.status,29,child.stderr); assert.equal(fs.readFileSync(marker,'utf8'),'once');
 fs.rmdirSync(path.join(dir,'.journal.lock'));
 const journal=new EncryptedChatJournal({directory:dir,key:Buffer.alloc(32,8)});
 try {
  let calls=0; const log=effects.createDurableToolEffects({enabled:true,journal,tools:{send:async()=>{calls++;return {status:'completed',result:'bad'}}}});
  await assert.rejects(log.execute({session:'s',turn:'t',call:'0',tool:'send',args:{}}),/blocked/);
  await assert.rejects(log.execute({session:'s',turn:'later',call:'1',tool:'send',args:{}}),/blocked/);
  assert.equal(calls,0);
  assert.equal(await log.execute({session:'other',turn:'t',call:'0',tool:'send',args:{}}),'bad');
 } finally {journal.close();}
});

test('exception, invalid output and concurrent attempt fail closed',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tool-unknown-')); const journal=new EncryptedChatJournal({directory:dir,key:Buffer.alloc(32,9)});
 t.after(()=>{journal.close();fs.rmSync(dir,{recursive:true,force:true});});
 assert.throws(()=>effects.createDurableToolEffects({journal,tools:{}}),/disabled/);
 let release; const gate=new Promise(r=>release=r); let calls=0;
 const log=effects.createDurableToolEffects({enabled:true,journal,tools:{send:async()=>{calls++;await gate;throw Error('uncertain')}}});
 const request={session:'s',turn:'t',call:'0',tool:'send',args:{}};
 const first=log.execute(request); await assert.rejects(log.execute(request),/blocked/); release(); await assert.rejects(first,/uncertain/);
 await assert.rejects(log.execute(request),/blocked/); assert.equal(calls,1);
 const invalid=effects.createDurableToolEffects({enabled:true,journal,tools:{send:async()=>undefined}});
 const second={...request,session:'x'}; await assert.rejects(invalid.execute(second),/unknown/); await assert.rejects(invalid.execute(second),/blocked/);
});
