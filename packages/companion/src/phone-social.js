export async function runSocialInteraction({observe,decide,submit,verify,save=async()=>{}}){
 const seen=await observe();
 if(!seen || !['fanqie','hongguo'].includes(seen.platform) || !seen.contentId || !seen.text?.trim()) return {ok:false,reason:'no-evidence'};
 const choice=await decide(seen);
 if(choice?.action==='skip')return {ok:true,reason:'declined'};
 if(!['comment','reply','like'].includes(choice?.action) || (choice.action!=='like' && (typeof choice.text!=='string'||!choice.text.trim())))return {ok:false,reason:'invalid-choice'};
 const submitted=await submit({seen,choice}); if(!submitted?.ok)return {ok:false,reason:'submit-failed'};
 const evidence=await verify({seen,choice,submitted}); if(!evidence?.ok || typeof evidence.reference!=='string' || !evidence.reference.trim())return {ok:false,reason:'unverified'};
 const record={platform:seen.platform,contentId:seen.contentId,action:choice.action,evidence:evidence.reference}; await save(record);return {ok:true,record};
}
