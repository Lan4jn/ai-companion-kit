import {checkOutboundPrivacy} from './outbound-privacy.js';
import {isEmptyPublicFishCliche} from './public-comment-naturalness.js';

// No default device IO exists: observed composer controls do not establish identity.
// A validated IO adapter supplies observe, fill, submit and independent readBack.
// Target and comment IDs must be stable platform identifiers, not display text.
export function createFanqiePublicationAdapter({serial,configuredSerial=process.env.PHONE_SERIAL,ownerIds=[],accountId,io}={}) {
 if(typeof serial!=='string'||!serial.trim()||serial!==configuredSerial) throw new Error('专属设备未配置或不匹配');
 let used=false, verified=null, requestKey=null;
 const nonempty=x=>typeof x==='string' && x.trim()===x && x.length>0;
 const validTarget=t=>t && nonempty(t.bookId) && nonempty(t.threadId);
 const sameTarget=(a,b)=>validTarget(a)&&validTarget(b)&&a.bookId===b.bookId&&a.threadId===b.threadId;
 // observe() must attest baselineComplete only when all existing IDs in the
 // target thread are known, not just those currently on screen. Callers must
 // retain this one-shot instance after failures; it is not durable across restarts.
 // observe() returns target, authenticated, accountId, composer, text,
 // submitEnabled, baselineComplete and the complete existing comment IDs.
 const validState=(s,t)=>s && sameTarget(s.target,t) && s.authenticated===true && s.accountId===accountId && s.composer===true && s.submitEnabled===true && s.baselineComplete===true && Array.isArray(s.visibleCommentIds) && s.visibleCommentIds.every(nonempty) && new Set(s.visibleCommentIds).size===s.visibleCommentIds.length;
 const key=r=>JSON.stringify([r?.target?.bookId,r?.target?.threadId,r?.choice?.action,r?.choice?.text]);
 return {
  async submit(request={}) {
   if(used)return {ok:false,reason:'attempt-already-used'};
   used=true;
   if(!io || ['observe','fill','submit','readBack'].some(n=>typeof io[n]!=='function'))return {ok:false,reason:'publication-evidence-unavailable'};
   const {target,choice}=request;
   if(!validTarget(target)||!nonempty(accountId)||choice?.action!=='comment'||typeof choice.text!=='string'||!choice.text.trim())return {ok:false,reason:'invalid-request'};
   if(Array.from(choice.text).length>50)return {ok:false,reason:'reply-too-long'};
   if(isEmptyPublicFishCliche(choice.text))return {ok:false,reason:'public-comment-cliche'};
   if(!Array.isArray(ownerIds)||!ownerIds.some(id=>/^\d{5,}$/.test(String(id))))return {ok:false,reason:'privacy-unconfigured'};
   if(!checkOutboundPrivacy(choice.text,ownerIds).safe)return {ok:false,reason:'privacy-blocked'};
   const expectedTarget={bookId:target.bookId,threadId:target.threadId}, text=choice.text;
   requestKey=key(request);
   try {
    const before=await io.observe();
    if(!validState(before,expectedTarget)||before.text!=='')return {ok:false,reason:'context-unverified'};
    const existing=new Set(before.visibleCommentIds);
    const ready=await io.observe();
    if(!validState(ready,expectedTarget)||ready.text!==before.text||JSON.stringify(ready.visibleCommentIds)!==JSON.stringify(before.visibleCommentIds))return {ok:false,reason:'context-changed'};
    await io.fill(text);
    const review=await io.observe();
    if(!validState(review,expectedTarget)||review.text!==text||JSON.stringify(review.visibleCommentIds)!==JSON.stringify(before.visibleCommentIds))return {ok:false,reason:'review-failed'};
    if(!checkOutboundPrivacy(review.text,ownerIds).safe)return {ok:false,reason:'privacy-blocked'};
    // One attempt, including ambiguous results and exceptions; never retry.
    const result=await io.submit();
    if(result?.ok!==true)return {ok:false,reason:'submit-unknown'};
    const observed=await io.readBack();
    if(!sameTarget(observed?.target,expectedTarget)||observed?.accountId!==accountId||!Array.isArray(observed?.comments))return {ok:false,reason:'unverified'};
    const matches=observed.comments.filter(c=>nonempty(c?.id)&&!existing.has(c.id)&&c.authorId===accountId&&c.text===text);
    if(matches.length!==1||observed.comments.filter(c=>c?.id===matches[0].id).length!==1)return {ok:false,reason:'unverified'};
    verified={ok:true,reference:matches[0].id};
    return {...verified};
   } catch {return {ok:false,reason:'publication-unknown'};}
  },
  async verify(request) {
   return verified && key(request)===requestKey ? {...verified} : {ok:false,reason:'unverified'};
  }
 };
}
