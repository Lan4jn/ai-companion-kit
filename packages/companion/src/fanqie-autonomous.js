import {isForwardProgress} from './fanqie-reading.js';

export async function verifiedTurn({getProgress,capture,gesture,expected}) {
 const before=await getProgress();
 if(!before || before.page!==expected?.page || before.total!==expected?.total || before.chapter!==expected?.chapter)return {ok:false,reason:'reader-changed'};
 const oldPage=await capture();if(!oldPage?.text)return {ok:false,reason:'no-content'};
 await gesture();
 const after=await getProgress();if(!isForwardProgress(before,after))return {ok:false,reason:'progress-unverified'};
 const page=await capture();if(!page?.text)return {ok:false,reason:'content-unavailable'};
 const grams=s=>{s=s.replace(/[^\u4e00-\u9fff]/g,'');return new Set(Array.from({length:Math.max(0,s.length-5)},(_,i)=>s.slice(i,i+6)));};
 const a=grams(oldPage.text),b=grams(page.text);let common=0;for(const x of a)if(b.has(x))common++;
 if(!a.size||!b.size||common/Math.min(a.size,b.size)>0.65)return {ok:false,reason:'text-change-unverified'};
 return {ok:true,progress:after};
}

export async function decideReading(brain,text) {
 const raw=await brain.complete({system:'只根据小说OCR原文判断，识别可能有误，不得编造。只输出JSON。',prompt:`你读到下面的内容，判断自己是否感兴趣、是否想继续读，输出 {"interested":true或false,"continueReading":true或false,"summary":"只概括可见内容","keywords":["关键词"]}。\n<正文>\n${String(text).slice(0,2500)}\n</正文>`,max_tokens:500,temperature:0.4,json:true});
 if (!raw) return null;
 try { return JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g,'')); } catch { return null; }
}

// A reading step consumes observed text only; actions must be independently verified.
export async function runReadingStep({observe,understand,save,turn}) {
 const observed=await observe();
 if(!observed?.text || !observed?.progress) return {ok:false,reason:'reading-unavailable'};
 const thought=await understand(observed.text);
 if(typeof thought?.interested!=='boolean'||typeof thought?.continueReading!=='boolean'||typeof thought.summary!=='string'||!thought.summary.trim()||!Array.isArray(thought.keywords))return {ok:false,reason:'understanding-unavailable'};
 if(thought.interested)await save({source:observed.source,summary:thought.summary,keywords:thought.keywords,progress:observed.progress,fingerprint:observed.fingerprint,at:new Date().toISOString()});
 if(!thought.continueReading)return {ok:true,stopped:true};
 const turned=await turn(observed.progress);
 if(!turned?.ok)return {ok:false,reason:turned?.reason||'turn-unverified'};
 return {ok:true,stopped:false,progress:turned.progress};
}
