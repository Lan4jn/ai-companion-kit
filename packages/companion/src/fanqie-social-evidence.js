// UI labels are observations, not authentication credentials or stable IDs.
const profile='com.dragon.read/.social.profile.ProfileActivity';
const detail='com.dragon.read/com.dragon.community.impl.detail.page.CSSBookCommentDetailsActivity';
export function inspectFanqieEvidence({activity,xml}={}) {
 const result={profile:null,review:null};
 if(typeof xml!=='string'||!/^\s*<\?xml[^>]*>\s*<hierarchy\b/.test(xml)||!/<\/hierarchy>\s*$/.test(xml)||/<!DOCTYPE|<!ENTITY|用户协议|隐私政策|验证码|登录|同意并/i.test(xml)) return result;
 const nodes=[...xml.matchAll(/<node\s+[^>]*>/g)].map(m=>m[0]);
 const attr=(n,k)=>new RegExp(`(?:^|\\s)${k}="([^"]*)"`).exec(n)?.[1] || '';
 const texts=(predicate)=>nodes.filter(predicate).map(n=>attr(n,'text')).filter(Boolean);
 if(activity===profile && nodes.some(n=>attr(n,'content-desc')==='profile avatar') && nodes.some(n=>attr(n,'text')==='编辑资料')) {
  const avatars=nodes.map((n,i)=>attr(n,'content-desc')==='profile avatar'?i:-1).filter(i=>i>=0);
  // On the observed profile layout, the name is the immediate next node.
  if(avatars.length===1) {const n=nodes[avatars[0]+1];const name=n&&attr(n,'text');if(name&&attr(n,'class')==='android.widget.TextView'&&!/[&<>]/.test(name)) result.profile={displayName:name,ownProfileVisible:true,stableAccountId:null};}
 }
 if(activity===detail && nodes.some(n=>attr(n,'text')==='书评详情')) {
  const titles=texts(n=>attr(n,'resource-id')==='com.dragon.read:id/jbr');
  const bodies=texts(n=>attr(n,'resource-id')==='com.dragon.read:id/text');
  if(titles.length===1 && bodies.length && !/[&<>]/.test(titles[0]) && !/[&<>]/.test(bodies[0])) result.review={bookTitle:titles[0],reviewText:bodies[0],stableReviewId:null};
 }
 return result;
}
