// Only this direct POST path may capture receipts; local same-UID tampering is outside the trust boundary.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {reserveComment,accountFromHeaders} from './bili-comment-ledger.js';
export const digest = v => crypto.createHash('sha256').update(v).digest('hex');
export const targetOf = (account,aid,root) => ({account:String(account),aid:String(aid),operation:root?'reply':'comment',root:String(root||'')});
export const keyOf = target => digest(JSON.stringify(target));
export function publish(dir,name,value) {
 const tmp=path.join(dir,`.${crypto.randomUUID()}.tmp`); let fd;
 try {fd=fs.openSync(tmp,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(value)+'\n');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.linkSync(tmp,path.join(dir,name));const d=fs.openSync(dir,'r');try{fs.fsyncSync(d);}finally{fs.closeSync(d);}return true;}
 finally {if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(tmp);}catch{}}
}
const decimal = v => typeof v==='string'&&/^(0|[1-9]\d*)$/.test(v)?v:Number.isSafeInteger(v)&&v>=0?String(v):'';
function originFor(testEndpoint) {if(!testEndpoint)return 'https://api.bilibili.com';const u=new URL(testEndpoint);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('invalid test endpoint');return u.origin;}
export async function sendReservedReply({account,aid,root,message,headers,ledgerDir,testEndpoint}) {
 if(typeof message !== 'string' || !message.trim())return {ok:false,code:'invalid_text'};
 if(Array.from(message).length>50)return {ok:false,code:'reply_too_long'};
 const dir=ledgerDir||process.env.BILI_COMMENT_LEDGER_DIR||path.join(process.env.HOME||'/root','.bili-ai','comment-ledger');
 const target=targetOf(account,aid,root); const csrf=(headers?.cookie||'').match(/(?:^|;\s*)bili_jct=([^;]+)/)?.[1];
 if(!csrf||accountFromHeaders(headers)!==target.account||!root)return {ok:false,code:'comment_identity_missing'};
 let origin;try{origin=originFor(testEndpoint);}catch{return {ok:false,code:'invalid_endpoint'};}
 const reservation=reserveComment({...target,message,ledgerDir:dir});if(!reservation.ok)return reservation;
 try {
  const body=new URLSearchParams({oid:target.aid,type:'1',root:target.root,parent:target.root,message,plat:'1',csrf});
  const res=await fetch(origin+'/x/v2/reply/add',{method:'POST',headers:{...headers,'content-type':'application/x-www-form-urlencoded'},body,redirect:'error',signal:AbortSignal.timeout(25000)});
  const j=await res.json(); const r=j?.data?.reply; const rid=decimal(j?.data?.rpid_str??j?.data?.rpid);
  if(res.ok&&j.code===0&&/^[1-9]\d*$/.test(rid)&&decimal(r?.rpid_str??r?.rpid)===rid&&decimal(r?.oid)===target.aid&&decimal(r?.mid)===target.account&&decimal(r?.type)==='1'&&decimal(r?.root)===target.root&&decimal(r?.parent)===target.root&&r?.content?.message===message){
   const entry=fs.readFileSync(path.join(dir,keyOf(target)+'.json'),'utf8');
   publish(dir,keyOf(target)+'.receipt.json',{version:1,target,rpid:rid,entrySha256:digest(entry),source:'bilibili_reply_add',testOnly:!!testEndpoint});
  }
  return {ok:res.ok&&j.code===0,code:res.ok?j.code:'http_error',message:j.message||''};
 }catch{return {ok:false,code:'net'};}
}
