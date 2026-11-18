import path from 'node:path';
import {createManagedMemoryBrain} from './memory-brain-trust.js';
import {validBiliFeeling} from './bili-feeling-memory.js';
import {openFragmentVault} from './bili-fragment-vault.js';
import {isDeepStrictEqual} from 'node:util';

// Background work may consult only the owner's existing forget ledger, never
// recall arbitrary memories from it. Scope is pinned to one configured owner.
export function createBiliBackgroundFilter(cfg, dataDir) {
 return async (rows, write) => {
  try {
   const m=cfg?.memoryBrain, scope=m?.trustedScope;
   if (m?.enabled!==true || m.trustedProcess!==true || !Array.isArray(cfg.ownerIds) || cfg.ownerIds.length!==1 ||
       String(cfg.ownerIds[0])!==scope?.user || scope?.tenant!=='companion' || scope.platform!=='qq' || scope.type!=='private' ||
       scope.session!==`private:${scope.user}` || !Array.isArray(m.authorizedSources) || !m.authorizedSources.includes('bili-observation') ||
       !path.isAbsolute(dataDir || '') || path.resolve(cfg.dataDir || '')!==dataDir) return [];
   const authentic = rec => {
    if (!validBiliFeeling(rec)) return false;
    const f=rec.biliFeeling;
    if (f.version!==2) return true;
    const c=f.credential, p=c?.payload;
    if (!p || !isDeepStrictEqual(p.scope,scope) || p.bvid!==f.bvid || p.duration!==f.duration ||
        !isDeepStrictEqual(p.segment,f.evidence.segment) || !isDeepStrictEqual(p.browserResult,f.evidence.browserResult)) return false;
    return openFragmentVault(path.join(dataDir,'bili-fragment-vault')).verify(c.token,p);
   };
   const candidates=(Array.isArray(rows)?rows:[]).filter(authentic);
   if (!candidates.length) return [];
   const store=createManagedMemoryBrain({directory:path.join(dataDir,'memory-brain-scoped'),scope,sources:['bili-observation'],trustedProcess:true,backend:m.backend,python:m.python,engineRoot:m.engineRoot});
   if (write !== undefined) {
    if (typeof write !== 'function' || candidates.length !== 1 || rows.length !== 1) return [];
    const rec=candidates[0], url=`https://www.bilibili.com/video/${rec.biliFeeling.bvid}`;
    const evidence=rec.biliFeeling.version===2 ? [url,rec.biliFeeling.sourceId] : [url];
    return await store.filterCandidates(scope,{candidates:evidence.map(evidence=>({source:'bili-observation',evidence})),onAllowed:async indices=>{
     if (indices.length!==evidence.length || new Set(indices).size!==evidence.length || !authentic(rec)) return [];
     await write(rec);
     return [rec];
    }});
   }
   const allowed=[];
   for (let i=0;i<candidates.length;i+=50) {
    const batch=candidates.slice(i,i+50);
    const keys=batch.flatMap(r=>{const url=`https://www.bilibili.com/video/${r.biliFeeling.bvid}`; return r.biliFeeling.version===2 ? [url,r.biliFeeling.sourceId] : [url];});
    const indices=await store.filterCandidates(scope,{candidates:keys.map(evidence=>({source:'bili-observation',evidence}))});
    if (!Array.isArray(indices) || indices.some(n=>!Number.isInteger(n)||n<0||n>=keys.length) || new Set(indices).size!==indices.length) return [];
    const permitted=new Set(indices); let k=0;
    for (const r of batch) { const count=r.biliFeeling.version===2?2:1; const ok=Array.from({length:count},(_,j)=>permitted.has(k+j)).every(Boolean); k+=count; if (ok && authentic(r)) allowed.push(r); }
   }
   return allowed;
  } catch {return [];}
 };
}
