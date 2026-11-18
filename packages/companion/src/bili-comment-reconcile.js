// Explicit, read-only anonymous reconciliation. Never called by posting paths.
// A same-UID operator can tamper with local data; this is not an attestation boundary.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {publish} from './bili-comment-send.js';

const digest = v => crypto.createHash('sha256').update(v).digest('hex');
const id = v => typeof v === 'string' && /^[1-9]\d*$/.test(v);
const decimal = v => typeof v === 'string' ? (/^\d+$/.test(v) ? v : '') : (Number.isSafeInteger(v) && v >= 0 ? String(v) : '');

// Caller is a local human selecting a candidate rpid; no credentials are used.
// testEndpoint permits loopback only and must be explicitly supplied.
export async function reconcileComment({account,aid,root='',rpid,ledgerDir,testEndpoint}) {
 const unknown={status:'unknown'};
 try {
  if(!id(account)||!id(aid)||!id(rpid)||(root&&!id(root))||!ledgerDir) return unknown;
  const target={account,aid,operation:root?'reply':'comment',root};
  const key=digest(JSON.stringify(target));
  const source=path.join(ledgerDir,key+'.json');
  const entryBytes=fs.readFileSync(source,'utf8');
  const entry=JSON.parse(entryBytes);
  if (JSON.stringify(Object.fromEntries(Object.keys(target).map(k=>[k,entry[k]])))!==JSON.stringify(target)||entry.status!=='unknown'||!/^\w{64}$/.test(entry.messageSha256)||!Number.isFinite(Date.parse(entry.createdAt))) return unknown;
  let origin='https://api.bilibili.com';
  if(testEndpoint){const u=new URL(testEndpoint);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.username||u.password||u.pathname!=='/'||u.search||u.hash) return unknown;origin=u.origin;}
  const candidates=[]; let count=null, seen=0; const ids=new Set();
  for(let pn=1;pn<=100;pn++){
   const u=new URL(root?'/x/v2/reply/reply':'/x/v2/reply',origin);
   for(const [k,v] of Object.entries({type:'1',oid:aid,ps:'20',pn:String(pn),...(root?{root}:{sort:'0',nohot:'1'})})) u.searchParams.set(k,v);
   const response=await fetch(u,{method:'GET',headers:{accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(5000)});
   if(!response.ok) return unknown;
   const length=Number(response.headers.get('content-length'));if(length>1024*1024)return unknown;
   const body=await response.text();if(body.length>1024*1024)return unknown;
   const j=JSON.parse(body);const p=j?.data?.page;const list=j?.data?.replies;
   if(j.code!==0||!p||p.num!==pn||!Number.isSafeInteger(p.count)||p.count<0||!Number.isSafeInteger(p.size)||p.size!==20||!Array.isArray(list)||list.length>20) return unknown;
   if(count===null) count=p.count; else if(count!==p.count)return unknown;
   for(const x of list){
    const rid=decimal(x.rpid_str??x.rpid);if(!id(rid)||ids.has(rid))return unknown;ids.add(rid);seen++;
    if(decimal(x.oid)!==aid||decimal(x.type)!=='1'||decimal(x.mid)!==account||decimal(x.root)!==(root||'0')||decimal(x.parent)!==(root||'0')||x.state!==0||typeof x.content?.message!=='string'||digest(x.content.message)!==entry.messageSha256||!Number.isSafeInteger(x.ctime)||x.ctime<Math.floor(Date.parse(entry.createdAt)/1000)||x.ctime>Math.floor(Date.now()/1000)+1) continue;
    candidates.push(rid);
   }
   if(seen===count)break;
   if(seen>count||list.length!==20||pn===100)return unknown;
  }
  if(candidates.length!==1||candidates[0]!==rpid)return unknown;
  // A public match alone is not causal evidence. Only a receipt captured by
  // the direct submission path, bound to the immutable reservation, qualifies.
  let receipt; try {receipt=JSON.parse(fs.readFileSync(path.join(ledgerDir,key+'.receipt.json'),'utf8'));} catch {return {status:'unknown',code:'causal_evidence_missing'};}
  if(receipt.version!==1||receipt.source!=='bilibili_reply_add'||receipt.testOnly!==!!testEndpoint||receipt.entrySha256!==digest(entryBytes)||receipt.rpid!==rpid||JSON.stringify(receipt.target)!==JSON.stringify(target)) return unknown;
  // If a sender crashed after linking but before syncing the directory, seal
  // the existing, already-fsynced receipt before publishing confirmation.
  const receiptDirFd=fs.openSync(ledgerDir,'r');try{fs.fsyncSync(receiptDirFd);}finally{fs.closeSync(receiptDirFd);}
  if(fs.readFileSync(source,'utf8')!==entryBytes)return unknown;
  const result={status:'confirmed',rpid,entrySha256:digest(entryBytes),receiptSha256:digest(JSON.stringify(receipt)),confirmedAt:new Date().toISOString()};
  try {publish(ledgerDir,key+'.confirmed.json',result);} catch(e) {
   if(e.code!=='EEXIST')return unknown;
   const prior=JSON.parse(fs.readFileSync(path.join(ledgerDir,key+'.confirmed.json'),'utf8'));
   if(prior.status!=='confirmed'||prior.rpid!==rpid||prior.entrySha256!==result.entrySha256||prior.receiptSha256!==result.receiptSha256)return unknown;
   const d=fs.openSync(ledgerDir,'r');try{fs.fsyncSync(d);}finally{fs.closeSync(d);}
  }
  return {status:'confirmed',rpid};
 } catch {return unknown;}
}
