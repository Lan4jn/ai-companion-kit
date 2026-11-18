// Parse only the observed Compose recommendation-card structure. Unknown layouts fail closed.
const wall = /用户协议|隐私政策|同意并继续|登录后|登录以|请先登录|手机号登录|验证码登录|扫码登录|注册登录|sign\s*in|privacy policy|terms of service/i;
const decode = s => s.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, m => ({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"}[m] ?? String.fromCodePoint(m[2].toLowerCase() === 'x' ? parseInt(m.slice(3,-1),16) : parseInt(m.slice(2,-1),10))));
const bounds = s => { const m=/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(s||''); if(!m)return null;const a=m.slice(1).map(Number);return a[2]>a[0]&&a[3]>a[1]&&a[2]<=10000&&a[3]<=10000?a:null; };
export function extractHongguoCards(xml) {
 try {
  if(typeof xml!=='string'||xml.length>8e6||wall.test(xml)||/<!DOCTYPE|<!ENTITY/i.test(xml)) return [];
  const stack=[], roots=[]; const tags=xml.match(/<[^>]+>/g)||[];
  for(const tag of tags){
   if(/^<\?/.test(tag)) continue;
   if(/^<\//.test(tag)){const name=tag.match(/^<\/([\w.-]+)\s*>$/)?.[1];if(!name||stack.pop()?.name!==name)return [];continue;}
   const m=tag.match(/^<([\w.-]+)([\s\S]*?)(\/?)>$/);if(!m)return [];
   const node={name:m[1],attrs:{},children:[]};for(const a of m[2].matchAll(/([\w:-]+)="([^"]*)"/g))node.attrs[a[1]]=decode(a[2]);
   if(stack.length)stack.at(-1).children.push(node);else roots.push(node);if(!m[3])stack.push(node);
  }
  if(stack.length||roots.length!==1||roots[0].name!=='hierarchy')return [];
  const cards=[];
  const walk=(n,inCompose=false)=>{inCompose ||= n.attrs.class==='androidx.compose.ui.platform.ComposeView';
   const b=bounds(n.attrs.bounds);
   if(inCompose&&n.attrs.class==='android.view.View'&&n.attrs.clickable==='true'&&n.attrs.enabled==='true'&&b&&b[2]-b[0]>=100&&b[3]-b[1]>=150&&n.children.length===1){
    const body=n.children[0];const titles=body.children.filter(x=>x.attrs.class==='android.widget.TextView'&&typeof x.attrs.text==='string'&&x.attrs.text.trim());
    if(titles.length===1){const title=titles[0].attrs.text.trim();const tb=bounds(titles[0].attrs.bounds);if(tb&&tb[0]>=b[0]&&tb[2]<=b[2]&&tb[1]>=b[1]&&tb[3]<=b[3]&&title.length>=2&&title.length<=100){
      const desc=[];const gather=x=>{if(x!==titles[0]&&x.attrs.text?.trim())desc.push(x.attrs.text.trim());for(const c of x.children)gather(c);};gather(body);cards.push({title,description:desc.join(' · ').slice(0,300),bounds:n.attrs.bounds});
    }}
   }
   for(const c of n.children)walk(c,inCompose);
  };walk(roots[0]);return cards.filter(c=>cards.filter(x=>x.title===c.title||x.bounds===c.bounds).length===1);
 } catch{return [];}
}
