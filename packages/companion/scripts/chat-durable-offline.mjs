#!/usr/bin/env node
// Local offline candidate: never sends or removes locks.
import fs from 'node:fs';
import path from 'node:path';
import {loadKey,checkKeyParent} from '../src/chat-durable-runtime-candidate.js';
import {EncryptedChatJournal} from '../src/chat-durable-journal-candidate.js';
import {inspectBatchJournal,acknowledgeDeliveredSegment,inspectBoundBatch,reconcileBoundSegment,inspectAcceptedInput,authorizeAcceptedInput,authorizeReadyBatch} from '../src/chat-durable-offline-recovery.js';

let journal, key;
try {
 const [command,...args]=process.argv.slice(2); const opts={};
 for(let i=0;i<args.length;i++) {
  const flag=args[i]; if(!flag.startsWith('--') || Object.hasOwn(opts,flag)) throw Error('invalid arguments');
  if(['--confirm-delivered','--authorize-resume','--confirm-not-generated','--confirm-trusted-ingress','--confirm-send'].includes(flag)) opts[flag]=true;
  else {if(!args[i+1] || args[i+1].startsWith('--')) throw Error('invalid arguments'); opts[flag]=args[++i];}
 }
 const allowed=command==='inspect-lock'?['--directory']:command==='inspect'?['--directory','--key']:command==='ack'?['--directory','--key','--id','--snapshot','--confirm-delivered']:command==='inspect-segments'||command==='inspect-input'?['--directory','--key','--id','--owner']:command==='approve-input'?['--directory','--key','--id','--owner','--snapshot','--confirm-not-generated','--confirm-trusted-ingress']:command==='approve-ready'?['--directory','--key','--id','--owner','--snapshot','--confirm-send']:command==='reconcile'?['--directory','--key','--id','--owner','--snapshot','--decision','--authorize-resume']:[];
 if(!allowed.length || Object.keys(opts).some(x=>!allowed.includes(x)) || allowed.some(x=>!opts[x])) throw Error('invalid arguments');
 const dir=opts['--directory']; if(!path.isAbsolute(dir)) throw Error('absolute directory required');
 checkKeyParent(path.join(dir,'journal.enc'));
 if(command==='inspect-lock') {
  const parent=fs.lstatSync(dir,{bigint:true});
  if(!parent.isDirectory() || parent.isSymbolicLink() || parent.uid!==BigInt(process.getuid()) || (parent.mode & 0o077n)) throw Error('unsafe directory');
  const lockPath=path.join(dir,'.journal.lock');
  const before=fs.lstatSync(lockPath,{bigint:true});
  if(!before.isDirectory() || before.isSymbolicLink() || before.uid!==BigInt(process.getuid()) || (before.mode & 0o077n)) throw Error('unsafe lock');
  const fd=fs.openSync(lockPath,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
  try {
   const actual=fs.fstatSync(fd,{bigint:true});
   if(actual.dev!==before.dev || actual.ino!==before.ino) throw Error('lock changed');
   // The writer creates an empty directory and records no owner identity.
   if(fs.readdirSync(`/proc/self/fd/${fd}`).length) throw Error('unknown lock contents');
   const after=fs.lstatSync(lockPath,{bigint:true});
   const parentAfter=fs.lstatSync(dir,{bigint:true});
   if(after.dev!==actual.dev || after.ino!==actual.ino || parentAfter.dev!==parent.dev || parentAfter.ino!==parent.ino) throw Error('lock changed');
   console.log(JSON.stringify({status:'owner-unknown',removed:false,lock:{device:String(actual.dev),inode:String(actual.ino)},warning:'No PID or process start time is recorded; this does not establish that the lock is stale. Stop all writers independently and investigate manually.'}));
  } finally {fs.closeSync(fd);}
 } else {
 // Never treat a missing journal as an empty one or remove stale locks.
 const st=fs.lstatSync(path.join(dir,'journal.enc'));
 if(!st.isFile() || st.isSymbolicLink()) throw Error('existing journal required');
 if(fs.readdirSync(dir).some(n=>n.startsWith('.journal-'))) throw Error('unfinished journal write requires investigation');
 key=loadKey(opts['--key']);
 journal=new EncryptedChatJournal({directory:dir,key}); key.fill(0); key=null;
 if(command==='inspect') console.log(JSON.stringify(inspectBatchJournal(journal)));
 else if(command==='inspect-input') console.log(JSON.stringify(inspectAcceptedInput(journal,opts['--id'],opts['--owner'])));
 else if(command==='approve-input') { authorizeAcceptedInput(journal,{id:opts['--id'],ownerId:opts['--owner'],snapshot:opts['--snapshot'],confirmNotGenerated:opts['--confirm-not-generated'],confirmTrustedIngress:opts['--confirm-trusted-ingress']}); console.log(JSON.stringify({recorded:true})); }
 else if(command==='approve-ready') { authorizeReadyBatch(journal,{id:opts['--id'],ownerId:opts['--owner'],snapshot:opts['--snapshot'],confirmSend:opts['--confirm-send']}); console.log(JSON.stringify({recorded:true})); }
 else if(command==='inspect-segments') console.log(JSON.stringify(inspectBoundBatch(journal,opts['--id'],opts['--owner'])));
 else if(command==='reconcile') { reconcileBoundSegment(journal,{id:opts['--id'],ownerId:opts['--owner'],snapshot:opts['--snapshot'],decision:opts['--decision'],authorizeResume:opts['--authorize-resume']}); console.log(JSON.stringify({recorded:true})); }
 else { acknowledgeDeliveredSegment(journal,opts['--id'],opts['--snapshot']); console.log(JSON.stringify({recorded:true})); }
 }
} catch {
 console.error('Offline operation refused; check arguments, permissions, lock and journal integrity.'); process.exitCode=1;
} finally { if(key) key.fill(0); if(journal) {try {journal.close();} catch {process.exitCode=1; console.error('Lock cleanup failed; investigate offline.');}} }
