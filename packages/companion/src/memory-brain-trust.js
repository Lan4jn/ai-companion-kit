import {lstatSync, realpathSync, mkdirSync, readdirSync, copyFileSync, openSync, closeSync, writeFileSync, fsyncSync, renameSync, constants} from 'node:fs';
import {isAbsolute, resolve, dirname, join} from 'node:path';
import {createMemoryBrain} from './memory-brain-adapter.js';
import {createMemoryManager} from './memory-brain-management.js';

const marker='.memory-brain-trust';
const fields=['tenant','platform','type','session','user'];
const valid=x=>typeof x==='string' && x.length>0 && x.length<=512 && x.trim()===x;
function checkDir(dir) {
 if (!isAbsolute(dir || '') || resolve(dir)!==dir || realpathSync(dir)!==dir) throw new Error('invalid directory');
 const st=lstatSync(dir);
 if (!st.isDirectory() || st.uid!==process.getuid() || (st.mode&0o077)) throw new Error('unsafe directory');
 return st;
}
function syncDir(dir) { const fd=openSync(dir,constants.O_RDONLY|constants.O_DIRECTORY); try {fsyncSync(fd);} finally {closeSync(fd);} }
function setState(dir,state) {
 const tmp=join(dir,`${marker}.new`), target=join(dir,marker);
 const fd=openSync(tmp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try {writeFileSync(fd,state+'\n'); fsyncSync(fd);} finally {closeSync(fd);}
 renameSync(tmp,target); syncDir(dir);
}
function state(dir) {
 checkDir(dir);
 const fd=openSync(join(dir,marker),constants.O_RDONLY|constants.O_NOFOLLOW);
 try {
  const st=lstatSync(join(dir,marker));
  if (!st.isFile() || st.uid!==process.getuid() || (st.mode&0o077) || st.nlink!==1 || st.size>32) throw new Error('unsafe trust marker');
  const buf=Buffer.alloc(32); const n=fsRead(fd,buf); const value=buf.subarray(0,n).toString();
  if (value!=='ready\n' && value!=='review\n' && value!=='incomplete\n') throw new Error('invalid trust marker');
  return value.trim();
 } finally {closeSync(fd);}
}
import {readSync as fsRead} from 'node:fs';
export function initializeManagedStore(directory) {
 checkDir(dirname(directory));
 if (!isAbsolute(directory || '') || resolve(directory)!==directory) throw new Error('invalid directory');
 mkdirSync(directory,{mode:0o700}); setState(directory,'ready'); syncDir(dirname(directory));
}
// Offline only: all readers/writers and restore processes must be stopped.
export function restoreManagedStore(backup,directory) {
 if (state(backup)!=='ready') throw new Error('backup not ready'); checkDir(dirname(directory));
 if (!isAbsolute(directory || '') || resolve(directory)!==directory || directory.startsWith(backup+'/') || backup.startsWith(directory+'/')) throw new Error('invalid destination');
 mkdirSync(directory,{mode:0o700}); setState(directory,'incomplete'); syncDir(dirname(directory));
 for (const name of readdirSync(backup)) {
  if (name===marker || name===`${marker}.new`) continue;
  const from=join(backup,name), st=lstatSync(from);
  // Forget locks are directory-bound, contain no data and must be recreated.
  if (/^\.forget-lock-[a-f0-9]{64}$/.test(name)) {
   if (!st.isFile() || st.uid!==process.getuid() || (st.mode&0o077) || st.nlink!==1) throw new Error('unsafe backup entry');
   continue;
  }
  if (!st.isFile() || st.uid!==process.getuid() || (st.mode&0o077) || st.nlink!==1 || !/^(?:ame-v1-)?[a-f0-9]{64}\.sqlite3(?:-wal|-shm|\.revoked|\.lock)?$/.test(name)) throw new Error('unsafe backup entry');
  copyFileSync(from,join(directory,name),constants.COPYFILE_EXCL);
  const fd=openSync(join(directory,name),constants.O_RDONLY|constants.O_NOFOLLOW); try {fsyncSync(fd);} finally {closeSync(fd);}
 }
 syncDir(directory); setState(directory,'review');
}
export function reviewManagedStore(directory,confirmation) {
 if (confirmation!=='I REVIEWED ALL REVOCATIONS AND FORGETS') throw new Error('confirmation required');
 if (state(directory)!=='review') throw new Error('store not awaiting review');
 setState(directory,'ready');
}
export function assertManagedStoreReady(directory) { if (state(directory)!=='ready') throw new Error('manual review required'); }
export function createManagedMemoryBrain({directory,scope,sources,trustedProcess,python,engineRoot,backend='legacy',maxChatHistoryTurns, management=false}={}) {
 if (trustedProcess!==true || !scope || fields.some(k=>!valid(scope[k])) || !Array.isArray(sources) || !sources.length || sources.some(s=>!valid(s))) throw new Error('invalid trusted process authorization');
 const initial=checkDir(directory), bound=Object.fromEntries(fields.map(k=>[k,scope[k]])), allowed=new Set(sources);
 const authorize=async (c,operation,source)=>{
  const st=checkDir(directory);
  if (st.dev!==initial.dev || st.ino!==initial.ino) throw new Error('memory directory changed');
  if (state(directory)!=='ready') throw new Error('manual review required');
  return fields.every(k=>c[k]===bound[k]) && allowed.has(source);
 };
 const options={enabled:true,backend,directory,python,engineRoot,maxChatHistoryTurns,authorize,recoveryAuthorization:authorize};
 if (management === true) return createMemoryManager({...options,authorizeManagement:async (operation,input)=>operation==='forget' && await authorize(input.context,operation,input.source)});
 return createMemoryBrain(options);
}
