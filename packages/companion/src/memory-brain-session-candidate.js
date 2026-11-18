import {mkdirSync, lstatSync, realpathSync} from 'node:fs';
import {isAbsolute, dirname, resolve} from 'node:path';
import {createMemoryBrain} from './memory-brain-adapter.js';

// Candidate-only capability: caller is a trusted local lifecycle manager, not chat.
// It must revoke continuity before any restore or uncertain transition.
export function initializeMemoryBrainSession({directory, scope, sources, continuity, python, engineRoot} = {}) {
 const fields=['tenant','platform','type','session','user'];
 const valid=x=>typeof x==='string' && x.length>0 && x.length<=512 && x.trim()===x;
 if (!isAbsolute(directory || '') || resolve(directory)!==directory || !scope || fields.some(k=>!valid(scope[k])) || !Array.isArray(sources) || !sources.length || sources.some(s=>!valid(s)) || typeof continuity!=='function') throw new Error('invalid trusted session');
 const parent=dirname(directory), parentStat=lstatSync(parent);
 if (realpathSync(parent)!==parent || !parentStat.isDirectory() || parentStat.uid!==process.getuid() || (parentStat.mode&0o077)) throw new Error('unsafe session parent');
 // Exclusive creation is intentional: no old or restored directory is accepted.
 mkdirSync(directory,{mode:0o700});
 const initial=lstatSync(directory), bound=Object.freeze(Object.fromEntries(fields.map(k=>[k,scope[k]]))), allowed=new Set(sources);
 let closed=false;
 async function authorize(c, operation, source) {
  if (closed) return false;
  try {
   const s=lstatSync(directory);
   if (!s.isDirectory() || s.isSymbolicLink() || s.uid!==process.getuid() || (s.mode&0o077) || s.dev!==initial.dev || s.ino!==initial.ino || realpathSync(directory)!==directory || await continuity()!==true) { closed=true; return false; }
  } catch { closed=true; return false; }
  return fields.every(k=>c[k]===bound[k]) && allowed.has(source);
 }
 const memory=createMemoryBrain({enabled:true,directory,python,engineRoot,authorize,
  recoveryAuthorization:(c,operation,source)=>authorize(c,operation,source)});
 return Object.freeze({memory,close(){closed=true;}});
}
