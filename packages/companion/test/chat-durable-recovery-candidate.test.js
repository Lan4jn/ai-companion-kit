import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { EncryptedChatJournal, startDurableChatRecovery } from '../src/chat-durable-journal-candidate.js';

const request = (socketPath, value) => new Promise((resolve,reject) => {
 const socket=net.createConnection(socketPath); let data='';
 socket.on('connect',()=>socket.write(JSON.stringify(value)+'\n'));
 socket.on('data',chunk=>{data+=chunk}); socket.on('end',()=>resolve(JSON.parse(data))); socket.on('error',reject);
});

test('trusted local recovery skips only the reviewed unknown and persists across reopen', async () => {
 const base=fs.mkdtempSync('/run/chat-journal-candidate-'); const dir=path.join(base,'data'); fs.mkdirSync(dir,{mode:0o700});
 const key=Buffer.alloc(32,9); let j, server;
 try {
  j=new EncryptedChatJournal({directory:dir,key}); const first=j.append('private-a',{text:'secret'}); j.append('private-a',{text:'later'}); j.claim('private-a');
  assert.equal(j.claim('private-a'),null);
  server=await startDurableChatRecovery(j,{directory:path.join(base,'control')});
  const listing=await request(server.path,{action:'list'}); assert.equal(listing.entries.length,1);
  assert.doesNotMatch(JSON.stringify(listing),/private-a|secret/);
  assert.ok(listing.entries[0].attemptedAt);
  const id=listing.entries[0].id;
  assert.deepEqual(await request(server.path,{action:'resolve',id,decision:'safe-to-retry'}),{ok:false});
  assert.deepEqual(await request(server.path,{action:'resolve',id,decision:'discard'}),{ok:true});
  assert.deepEqual(await request(server.path,{action:'resolve',id,decision:'discard'}),{ok:false});
  assert.notEqual(j.list('private-a')[0].id,first);
  await server.close();server=null; j.close(); j=new EncryptedChatJournal({directory:dir,key});
  assert.equal(j.claim('private-a').payload.text,'later');
 } finally {if(server) await server.close(); if(j && !j.closed) j.close(); fs.rmSync(base,{recursive:true,force:true});}
});


test('acknowledged recovery survives SIGKILL without retrying the removed turn', {timeout:15000}, async () => {
 const base=fs.mkdtempSync('/run/chat-journal-crash-recovery-'); const dir=path.join(base,'data'); fs.mkdirSync(dir,{mode:0o700});
 const key=Buffer.alloc(32,9); const moduleUrl=new URL('../src/chat-durable-journal-candidate.js',import.meta.url).href;
 let j=new EncryptedChatJournal({directory:dir,key}); j.append('a',{text:'first'}); j.append('a',{text:'second'}); j.claim('a'); j.close();
 const code=`import {EncryptedChatJournal,startDurableChatRecovery} from ${JSON.stringify(moduleUrl)}; const j=new EncryptedChatJournal({directory:process.argv[1],key:Buffer.alloc(32,9)}); const s=await startDurableChatRecovery(j,{directory:process.argv[2]}); console.log(s.path);`;
 const child=spawn(process.execPath,['--input-type=module','-e',code,dir,path.join(base,'control')],{stdio:['ignore','pipe','pipe']});
 const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
 try {
  const socketPath=await new Promise((resolve,reject)=>{child.stdout.once('data',b=>resolve(b.toString().trim()));child.once('error',reject);child.once('exit',()=>reject(Error('child exited early')))});
  const entries=(await request(socketPath,{action:'list'})).entries; assert.equal(entries.length,1);
  assert.deepEqual(await request(socketPath,{action:'resolve',id:entries[0].id,decision:'delivered'}),{ok:true});
  child.kill('SIGKILL'); assert.equal((await exited).signal,'SIGKILL');
  assert.throws(()=>new EncryptedChatJournal({directory:dir,key}),/lock/i);
  fs.rmdirSync(path.join(dir,'.journal.lock'));
  j=new EncryptedChatJournal({directory:dir,key}); assert.deepEqual(j.list('a').map(x=>x.payload.text),['second']); assert.equal(j.claim('a').payload.text,'second'); j.close();
 } finally {if(child.exitCode===null && child.signalCode===null) {child.kill('SIGKILL');await exited;} fs.rmSync(base,{recursive:true,force:true});}
});
