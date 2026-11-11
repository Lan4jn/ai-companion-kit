export function detailMatchesCandidate(candidate,nodes){
 const norm=s=>String(s||'').replace(/[^\p{L}\p{N}]/gu,'');
 const title=norm(candidate.title),desc=norm(candidate.description);
 const texts=nodes.map(n=>norm(n.text)).filter(Boolean);
 if(title.length>=3 && texts.some(t=>t.includes(title)))return true;
 if(desc.length<30)return false;
 return texts.some(t=>{if(t.length<30)return false;for(let i=0;i+30<=desc.length;i+=5)if(t.includes(desc.slice(i,i+30)))return true;return false});
}

export function extractCandidates(nodes){
 const list=nodes.map(n=>{const m=/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(n.bounds||'');return m?{text:String(n.text||'').trim(),x1:+m[1],y1:+m[2],x2:+m[3],y2:+m[4]}:null}).filter(n=>n&&n.x2>n.x1&&n.y2>n.y1);
 const out=[];for(const d of list){if(d.text.length<28||d.text.length>400)continue;const t=list.filter(n=>n.text.length>=2&&n.text.length<=32&&n.y2<=d.y1&&d.y1-n.y2<70&&Math.abs(n.x1-d.x1)<35).sort((a,b)=>b.y2-a.y2)[0];if(t&&!out.some(x=>x.title===t.text))out.push({title:t.text,description:d.text,x:Math.round((t.x1+t.x2)/2),y:Math.round((t.y1+t.y2)/2)});}return out.slice(0,8);
}
export async function chooseCandidate(brain,candidates){if(!candidates.length)return null;const response=await brain.complete({system:'你只能从提供的小说中选择，不想看就选0。只输出JSON。',prompt:`选择你感兴趣的小说，输出 {"choice":序号}，0表示不想读：\n${candidates.map((x,i)=>`${i+1}. ${x.title}：${x.description}`).join('\n')}`,json:true,max_tokens:200,temperature:0.7});try{const n=JSON.parse(response).choice;return Number.isInteger(n)&&n>=1&&n<=candidates.length?candidates[n-1]:null}catch{return null}}
