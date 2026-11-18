import fs from 'node:fs';
import path from 'node:path';
import {randomBytes,createHash} from 'node:crypto';

// A crashed owner leaves the lock behind intentionally: manual recovery is
// safer than stealing a lock from a paused process. All writers must cooperate.
export function createCredentialStore(dir) {
  const target=path.join(dir,'douyin-cookies.json');
  const generation=path.join(dir,'.douyin-credential-generation');
  const lock=path.join(dir,'.douyin-credential-lock');
  function atomic(file,bytes) {
    const tmp=file+'.'+randomBytes(16).toString('hex')+'.tmp';
    try {
      const fd=fs.openSync(tmp,'wx',0o600);
      try {fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
      fs.renameSync(tmp,file);
      const d=fs.openSync(dir,'r'); try {fs.fsyncSync(d);} finally {fs.closeSync(d);}
    } finally {try {fs.unlinkSync(tmp);} catch(e) {if(e.code!=='ENOENT') throw e;}}
  }
  function readOptional(file) {try{return fs.readFileSync(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
  function locked(fn) {
    fs.mkdirSync(dir,{recursive:true,mode:0o700});
    fs.mkdirSync(lock,{mode:0o700});
    try {return fn();} finally {fs.rmdirSync(lock);}
  }
  function read() {
    const g=readOptional(generation), bytes=readOptional(target);
    const hash=createHash('sha256').update(g || Buffer.from('initial')).update('\0').update(bytes || Buffer.from('absent')).digest('hex');
    let cookies=null;
    if (bytes !== null) {try {cookies=JSON.parse(bytes.toString('utf8'));} catch {cookies=undefined;}}
    return {version:hash,cookies};
  }
  function mutate(version,cookies,remove) {
    return locked(()=>{
      if(read().version!==version) return false;
      // Bump first. A crash can invalidate a snapshot, never validate a stale one.
      atomic(generation,randomBytes(32).toString('hex'));
      if(remove) {try {fs.unlinkSync(target);}catch(e){if(e.code!=='ENOENT')throw e;} const d=fs.openSync(dir,'r');try{fs.fsyncSync(d);}finally{fs.closeSync(d);}}
      else atomic(target,JSON.stringify(cookies));
      return true;
    });
  }
  return {snapshot:()=>locked(read),commit:(version,cookies)=>{if(!Array.isArray(cookies)) throw new TypeError('cookies must be an array');return mutate(version,cookies,false);},remove:version=>mutate(version,null,true)};
}
