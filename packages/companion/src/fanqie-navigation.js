export async function selectAndOpen({observe,choose,click,enter}) {
 const candidates=await observe();if(!candidates?.length)return {ok:false,reason:'no-candidates'};
 const picked=await choose(candidates);if(!picked)return {ok:false,reason:'not-interested'};
 const current=await observe();const item=current.find(x=>x.title===picked.title && x.description===picked.description);
 if(!item)return {ok:false,reason:'screen-changed'};
 if(!await click(item))return {ok:false,reason:'open-failed'};
 if(!await enter(item))return {ok:false,reason:'reader-unverified'};
 return {ok:true,title:item.title};
}
