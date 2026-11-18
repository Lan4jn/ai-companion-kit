#!/usr/bin/env node
import {createInterface} from 'node:readline/promises';
import {stdin,stdout} from 'node:process';
import {initializeManagedStore,restoreManagedStore,reviewManagedStore} from '../src/memory-brain-trust.js';
if (!stdin.isTTY || !stdout.isTTY) { console.error('Private authenticated interactive terminal required.'); process.exit(1); }
const rl=createInterface({input:stdin,output:stdout});
try {
 console.log('Stop all memory processes first. TTY is not authentication. Restores can resurrect revoked or forgotten memories.');
 const action=await rl.question('Action (init / restore / review): ');
 const directory=await rl.question('Absolute destination directory: ');
 if (action==='init') {
  if (await rl.question('Type INITIALIZE EMPTY STORE: ')!=='INITIALIZE EMPTY STORE') throw new Error('cancelled');
  initializeManagedStore(directory);
 } else if (action==='restore') {
  const backup=await rl.question('Absolute backup directory: ');
  if (await rl.question('Type RESTORE TO NEW DIRECTORY: ')!=='RESTORE TO NEW DIRECTORY') throw new Error('cancelled');
  restoreManagedStore(backup,directory);
 } else if (action==='review') {
  console.log('Independently inspect the entire backup and reapply every later revocation and forgetting for every affected scope/source. If history is incomplete, do not authorize.');
  reviewManagedStore(directory,await rl.question('Type I REVIEWED ALL REVOCATIONS AND FORGETS: '));
 } else throw new Error('unknown action');
 console.log('Completed.');
} catch(e) { console.error(e.message); process.exitCode=1; } finally {rl.close();}
