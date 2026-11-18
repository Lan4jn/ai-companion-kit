import fs from 'node:fs/promises';
import path from 'node:path';

export async function turnFanqiePage({capture,turn}) {
 const before=await capture();
 if (!before?.text) return {ok:false,reason:'no-reading-evidence'};
 if (!await turn()) return {ok:false,reason:'turn-failed'};
 const after=await capture();
 if (!after?.text) return {ok:false,reason:'verification-unavailable'};
 const grams=t=>{const s=t.replace(/[^\u4e00-\u9fff]/g,'');return new Set(Array.from({length:Math.max(0,s.length-5)},(_,i)=>s.slice(i,i+6)));};
 const a=grams(before.text),b=grams(after.text); let shared=0;for(const x of a)if(b.has(x))shared++;
 if (!a.size||!b.size||shared/Math.min(a.size,b.size)>0.65) return {ok:false,reason:'page-change-unverified'};
 return {ok:true,before,after};
}

export async function readFanqieOnce({capture,understand,save}) {
 const page=await capture();
 if (!page?.text || !page?.fingerprint || !page?.source) return {ok:false,reason:'no-reading-evidence'};
 const thought=await understand(page.text);
 if (!thought || typeof thought.interested!=='boolean' || typeof thought.summary!=='string' || !thought.summary.trim() || !Array.isArray(thought.keywords)) return {ok:false,reason:'understanding-unavailable'};
 const record={source:page.source,fingerprint:page.fingerprint,text:page.text,...(typeof page.bookId==='string'&&page.bookId.trim()?{bookId:page.bookId}:{}),...(typeof page.bookTitle==='string'&&page.bookTitle.trim()?{bookTitle:page.bookTitle}:{}),...(page.progress && typeof page.progress==='object'?{progress:page.progress}:{}),summary:thought.summary.slice(0,500),keywords:thought.keywords.filter(x=>typeof x==='string').slice(0,10),at:new Date().toISOString()};
 if(thought.interested) await save(record);
 return {ok:true,interested:thought.interested,record};
}
export async function understandFanqie(brain,text) {
 const r=await brain.complete({system:'你在阅读小说截图识别文字，OCR可能出错。只根据给定正文，不猜书名或后续剧情。只返回JSON。',prompt:`读以下小说片段，决定自己是否感兴趣。返回 {"interested":true或false,"summary":"仅概括可见正文","keywords":["相关词"]}。\n<正文>\n${text.slice(0,2500)}\n</正文>`,max_tokens:500,temperature:0.4,json:true});
 if(!r) return null;try{return JSON.parse(r.replace(/^```(?:json)?\s*|\s*```$/g,''))}catch{return null}
}
const memoryWrites=new Map();
function memoryKey(r){
 if(typeof r?.fingerprint!=='string'||!r.fingerprint.trim())return null;
 const book=typeof r.bookId==='string'&&r.bookId.trim()?['id',r.bookId]:typeof r.bookTitle==='string'&&r.bookTitle.trim()?['title',r.bookTitle]:['unknown',r.source];
 return JSON.stringify([book,r.fingerprint]);
}
export async function saveFanqieMemory(dir,record){
 const file=path.resolve(dir,'fanqie-reading.jsonl');
 const previous=memoryWrites.get(file)||Promise.resolve();
 const write=previous.catch(()=>{}).then(async()=>{
  await fs.mkdir(dir,{recursive:true,mode:0o700});
  const key=memoryKey(record);
  if(key){
   let content='';try{content=await fs.readFile(file,'utf8')}catch(e){if(e.code!=='ENOENT')throw e}
   for(const line of content.split('\n')){try{if(memoryKey(JSON.parse(line))===key)return}catch{}}
  }
  await fs.appendFile(file,JSON.stringify(record)+'\n',{mode:0o600});
 });
 memoryWrites.set(file,write);
 try{return await write}finally{if(memoryWrites.get(file)===write)memoryWrites.delete(file)}
}
export async function recallFanqie(dir,query,{limit=3}={}){
 const q=String(query||'').trim();
 if(!q)return [];
 let content;
 try{content=await fs.readFile(path.join(dir,'fanqie-reading.jsonl'),'utf8')}
 catch(e){if(e.code==='ENOENT')return [];throw e}
 const recentRequest=/(小说|番茄|书)/.test(q) && /(最近|刚才|刚刚|现在|这两天)/.test(q) && /(看|读|阅读)/.test(q);
 const rows=[];
 for(const line of content.split('\n')){
  if(!line.trim())continue;
  let r;try{r=JSON.parse(line)}catch{continue}
  if(!r || typeof r!=='object' || Array.isArray(r) || typeof r.text!=='string' || !r.text.trim() || typeof r.summary!=='string' || !r.summary.trim() || typeof r.source!=='string' || !r.source.trim())continue;
  const keywords=Array.isArray(r.keywords)?r.keywords:[];
  if((recentRequest && typeof r.text==='string' && r.text.trim()) || [...keywords,r.summary,r.bookTitle].some(w=>typeof w==='string' && w.trim().length>=2 && (q.includes(w.trim())||w.trim().includes(q))))rows.push(r);
 }
 const seen=new Set(),unique=[];
 for(const r of rows.reverse()){
  const key=memoryKey(r);
  if(key && seen.has(key))continue;
  if(key)seen.add(key);
  unique.push(r);
  if(unique.length>=limit)break;
 }
 return unique;
}
