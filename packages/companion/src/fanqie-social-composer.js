// Observation only: these version-specific controls were seen in a book-review
// thread, not a book-level review. They do not establish login or publication.
const detail='com.dragon.read/com.dragon.community.impl.detail.page.CSSBookCommentDetailsActivity';
export function inspectFanqieComposer({activity,xml}={}) {
 const result={composer:false,login:'unknown',canPublish:false};
 if(activity!==detail || typeof xml!=='string' || !/^\s*<\?xml[^>]*>\s*<hierarchy\b/.test(xml) || !/<\/hierarchy>\s*$/.test(xml) || /<!DOCTYPE|<!ENTITY|用户协议|隐私政策|验证码|登录|同意并/i.test(xml)) return result;
 const nodes=[...xml.matchAll(/<node\s+[^>]*>/g)].map(m=>m[0]);
 const matches=(node,id,klass,text)=>node.includes(`resource-id="com.dragon.read:id/${id}"`) && node.includes(`class="${klass}"`) && node.includes(`text="${text}"`) && /\benabled="true"/.test(node);
 const fields=nodes.filter(n=>matches(n,'dfy','android.widget.EditText','发表评论...') && /\bfocused="true"/.test(n));
 const buttons=nodes.filter(n=>matches(n,'jyu','android.widget.TextView','发表') && /\bclickable="true"/.test(n));
 const validBounds=n=>{const m=/\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(n);return Boolean(m && +m[3]>+m[1] && +m[4]>+m[2] && +m[3]<=10000 && +m[4]<=10000);};
 result.composer=fields.length===1 && buttons.length===1 && validBounds(fields[0]) && validBounds(buttons[0]);
 return result;
}
