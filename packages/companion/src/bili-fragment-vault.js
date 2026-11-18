// Low-level credential primitive only. The caller is responsible for authorizing
// issuance after a real observation; importing this module does not establish it.
// Same-UID code is the trust root, not an adversary this vault can resist.
import fs from 'node:fs';
import path from 'node:path';
import {createHmac, randomBytes, timingSafeEqual} from 'node:crypto';

function safeDir(dir) {
 const s=fs.lstatSync(dir);
 if (!s.isDirectory() || s.isSymbolicLink() || s.uid!==process.getuid() || (s.mode & 0o077)) throw new Error('unsafe vault directory');
}
function safeFile(file) {
 const fd=fs.openSync(file,fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
 try {
  const s=fs.fstatSync(fd);
  if (!s.isFile() || s.uid!==process.getuid() || (s.mode & 0o077) || s.nlink!==1) throw new Error('unsafe vault file');
  return fs.readFileSync(fd);
 } finally {fs.closeSync(fd);}
}
function canonical(value) {
 if (value===null || typeof value==='boolean' || typeof value==='string') return JSON.stringify(value);
 if (typeof value==='number' && Number.isFinite(value)) return JSON.stringify(value);
 if (Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
 if (value && Object.getPrototypeOf(value)===Object.prototype) return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
 throw new Error('unsupported credential value');
}
export function openFragmentVault(dir) {
 if (!path.isAbsolute(dir)) throw new Error('vault path must be absolute');
 safeDir(path.dirname(dir));
 try {fs.mkdirSync(dir,{mode:0o700});} catch(e) {if(e.code!=='EEXIST') throw e;}
 safeDir(dir);
 const keyFile=path.join(dir,'key');
 try {
  const fd=fs.openSync(keyFile,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
  try {fs.writeFileSync(fd,randomBytes(32)); fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
 } catch(e) {if(e.code!=='EEXIST') throw e;}
 function key() {
  safeDir(path.dirname(dir)); safeDir(dir);
  const k=safeFile(keyFile); if(k.length!==32) throw new Error('invalid vault key'); return k;
 }
 key();
 function mac(nonce,data) {return createHmac('sha256',key()).update('bili-fragment-v1\0').update(nonce).update('\0').update(canonical(data)).digest('hex');}
 function verify(token,data) {
  try {
   if (!token || Object.keys(token).sort().join(',')!=='mac,nonce' || !/^[0-9a-f]{64}$/.test(token.nonce) || !/^[0-9a-f]{64}$/.test(token.mac)) return false;
   return timingSafeEqual(Buffer.from(token.mac,'hex'),Buffer.from(mac(token.nonce,data),'hex'));
  } catch {return false;}
 }
 return {
  issue(data) {const nonce=randomBytes(32).toString('hex'); return {nonce,mac:mac(nonce,data)};},
  verify,
  consume(token,data) {
   if (!verify(token,data)) return false;
   try {
    safeDir(dir);
    const fd=fs.openSync(path.join(dir,`used-${token.nonce}`),fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
    try {fs.writeFileSync(fd,token.mac); fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
    return true;
   } catch {return false;}
  },
 };
}
