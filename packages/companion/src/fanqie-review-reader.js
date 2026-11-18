import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {assertPhoneLock} from './phone-mutex.js';

const exec = promisify(execFile);
const reader = 'com.dragon.read/.reader.ui.ReaderActivity';
const reviews = 'com.dragon.read/com.dragon.community.impl.list.page.CSSBookCommentListActivity';
const pause = ms => new Promise(r => setTimeout(r, ms));
const decode = s => s.replace(/&#(x[\da-f]+|\d+);|&(amp|quot|apos|lt|gt);/gi, (all, number, named) => {
 if (number) { const n = number[0].toLowerCase() === 'x' ? parseInt(number.slice(1),16) : Number(number); try { return String.fromCodePoint(n); } catch { return all; } }
 return {amp:'&',quot:'"',apos:"'",lt:'<',gt:'>'}[named.toLowerCase()];
});
const nodes = xml => [...xml.matchAll(/<node\s+[^>]*>/g)].map(m => {
 const attrs = {}; for (const a of m[0].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]] = decode(a[2]); return attrs;
});
const safeXml = s => /^\s*<\?xml[^>]*>\s*<hierarchy\b/.test(s) && /<\/hierarchy>\s*$/.test(s) && !/<!DOCTYPE|<!ENTITY/i.test(s);
const blocked = s => /用户协议|隐私政策|同意并|验证码|privacy policy|sign\s*in|terms of service/i.test(s);

// Caller must hold the shared phoneMutex for the complete operation. This driver
// never sends, likes, follows, or opens the rating stars. Start with the reader's
// actual overflow sheet already open; no guessed overflow-button coordinates.
export function createFanqieReviewReader({serial, configuredSerial=process.env.PHONE_SERIAL, run=exec, wait=pause}={}) {
 if (!serial || serial !== configuredSerial || typeof run !== 'function') throw new Error('专属设备未配置或不匹配');
 const adb = async (...args) => { assertPhoneLock(); return String((await run('adb',['-s',serial,...args],{encoding:'utf8',timeout:20000,maxBuffer:8*1024*1024})).stdout); };
 const activity = async () => {
  const out=await adb('shell','dumpsys','activity','activities');
  const matches=[...out.matchAll(/topResumedActivity=.*?\s([\w.]+\/[\w.$]+)/g)].map(m=>m[1]);
  return matches.length===1 ? matches[0] : null;
 };
 const snapshot = async expected => {
  if (await activity()!==expected) return null;
  const result=await adb('shell','uiautomator','dump','/sdcard/fanqie-review-reader.xml');
  if (!/UI hierchary dumped to: \/sdcard\/fanqie-review-reader\.xml/.test(result)) return null;
  const xml=await adb('exec-out','cat','/sdcard/fanqie-review-reader.xml');
  if (!safeXml(xml) || blocked(xml) || await activity()!==expected) return null;
  return nodes(xml);
 };
 const target = list => {
  if (!list || !list.some(n=>n.text==='书籍详情') || !list.some(n=>n.text==='书圈')) return null;
  const found=list.filter(n=>n['resource-id']==='com.dragon.read:id/hoo' && /^(?:\d+(?:\.\d+)?万?)人点评$/.test(n.text||'') && n.clickable==='true' && n.enabled==='true');
  if(found.length!==1) return null;
  const b=/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(found[0].bounds||'');
  if(!b || +b[3]<=+b[1] || +b[4]<=+b[2] || +b[3]>10000 || +b[4]>10000) return null;
  return {text:found[0].text,bounds:found[0].bounds,x:Math.floor((+b[1]+ +b[3])/2),y:Math.floor((+b[2]+ +b[4])/2)};
 };
 return {
  async openComments() {
   const a=target(await snapshot(reader)); if(!a) return {ok:false};
   const b=target(await snapshot(reader)); if(!b || a.text!==b.text || a.bounds!==b.bounds || await activity()!==reader) return {ok:false};
   await adb('shell','input','tap',String(b.x),String(b.y)); await wait(1500);
   const list=await snapshot(reviews);
   return {ok:Boolean(list?.some(n=>n['resource-id']==='com.dragon.read:id/dg_' && /搜索.+的书评/.test(n.text||'')))};
  },
  async readComments() {
   const list=await snapshot(reviews);
   if(!list || !list.some(n=>n['resource-id']==='com.dragon.read:id/dg_' && /搜索.+的书评/.test(n.text||''))) return null;
   // IDs deliberately omitted: UI provides no stable comment identity and this
   // reader is not a publication/like/reply driver.
   return list.filter(n=>n['resource-id']==='com.dragon.read:id/text' && n.text?.trim()).map(n=>({text:n.text}));
  }
 };
}
