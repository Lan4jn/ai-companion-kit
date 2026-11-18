import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {extractCandidates,chooseCandidate,detailMatchesCandidate} from './fanqie-select.js';
import {selectAndOpen} from './fanqie-navigation.js';
import {getReaderProgress,captureFanqiePage,parseReaderProgress} from './fanqie-reading.js';
import { assertPhoneLock } from './phone-mutex.js';
const exec=promisify(execFile), delay=ms=>new Promise(r=>setTimeout(r,ms));
const center = bounds => { const m=/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(bounds||''); return m&&+m[3]>+m[1]&&+m[4]>+m[2] ? [Math.round((+m[1]+ +m[3])/2),Math.round((+m[2]+ +m[4])/2)] : null; };

// The reader and details share an activity. Verify title in the reader's catalog,
// then close the catalog and recheck the actual reading page.
export async function inspectCurrentReader(io) {
 const before=await io.progress(); if(!before)return null;
 let nodes=await io.dump(); let menu=nodes.find(n=>n.text==='目录'&&center(n.bounds));
 if(!menu && io.showControls){await io.showControls();nodes=await io.dump();menu=nodes.find(n=>n.text==='目录'&&center(n.bounds));}
 if(!menu)return null;
 const [x,y]=center(menu.bounds); if(!await io.tap(x,y))return null;
 let title=null, catalogOpen=false;
 try {
  const catalog=(await io.catalog()).filter(n=>typeof n.text==='string' && n.text.trim());
  catalogOpen=catalog.some(n=>n.text==='搜全文') && catalog.some(n=>n.text==='目录') && catalog.some(n=>/^(连载至|已完结|共\d+章)/.test(n.text||''));
  const anchors=catalog.map((n,i)=>n.text==='搜全文'?i:-1).filter(i=>i>=2);
  if(anchors.length===1 && catalog.some(n=>n.text==='目录') && catalog.some(n=>/^(连载至|已完结|共\d+章)/.test(n.text||''))) {
   const i=anchors[0], t=String(catalog[i-2]?.text||'').trim(), author=String(catalog[i-1]?.text||'').trim();
   if(t.length>=2 && t.length<=120 && author && !/^(目录|详情|搜全文|第\d+章)/.test(t))title=t;
  }
 } finally { if(catalogOpen)await io.back(); }
 const after=await io.progress();
 if(!title || !after || before.chapter!==after.chapter || before.page!==after.page || before.total!==after.total)return null;
 return {title,description:'当前阅读器中的书；书名由目录核验，尚未提供简介。',kind:'current-reader'};
}

export async function returnReaderToBookstore(io) {
 const valid=s=>{
  if(!/^(?:.*\s)?com\.dragon\.read\/[^\s]*ReaderActivity(?:\})?$/.test(s?.focus||''))return null;
  const nodes=s.nodes||[];
  if(nodes.some(n=>/隐私协议|用户协议|登录验证|安全验证|账号安全/.test(n.text||'')))return null;
  if(!s.progress || !nodes.some(n=>n.text==='目录' && n.packageName==='com.dragon.read') || !nodes.some(n=>n.text==='设置' && n.packageName==='com.dragon.read'))return null;
  const targets=nodes.filter(n=>n.id==='com.dragon.read:id/aah' && n.packageName==='com.dragon.read' && n.clickable && n.enabled && center(n.bounds));
  return targets.length===1?targets[0]:null;
 };
 const a=await io.snapshot(), first=valid(a); if(!first)return false;
 const b=await io.snapshot(), second=valid(b); if(!second || first.bounds!==second.bounds || JSON.stringify(a.progress)!==JSON.stringify(b.progress))return false;
 const [x,y]=center(second.bounds); if(!await io.tap(x,y))return false;
 return Boolean(await io.bookstore());
}

export async function selectCurrentReader({inspect,choose}) {
 const candidate=await inspect();if(!candidate)return {ok:false,reason:'no-candidates'};
 let picked;try{picked=await choose([candidate]);}catch{return {ok:false,reason:'selection-unavailable'};}
 if(!picked)return {ok:false,reason:'not-interested'};
 if(picked.title!==candidate.title)return {ok:false,reason:'selection-unavailable'};
 const fresh=await inspect();if(!fresh || fresh.title!==candidate.title)return {ok:false,reason:'screen-changed'};
 return {ok:true,resumed:true,bookTitle:candidate.title};
}
export async function verifyOpenedReader(item,io) {
 if (!await io.progress() || !await io.capture()) return false;
 let nodes=await io.dump(); let menu=nodes.find(n=>n.text==='目录'&&center(n.bounds));
 if(!menu && io.showControls){await io.showControls();nodes=await io.dump();menu=nodes.find(n=>n.text==='目录'&&center(n.bounds));}
 if(!menu)return false;
 const [x,y]=center(menu.bounds); if(!await io.tap(x,y))return false;
 const catalog=await io.catalog();
 const isCatalog=catalog.some(n=>n.text==='目录')&&catalog.some(n=>/^(连载至|已完结|共\d+章)/.test(n.text));
 if(!isCatalog)return false;
 const matched=catalog.some(n=>{
  const actual=String(n.text||'').trim(), expected=String(item.title||'').trim();
  if (!expected) return false;
  return actual===expected || (expected.length>=6 && actual.startsWith(expected) && /^\s*[（(][^（）()]{1,40}[）)]\s*$/.test(actual.slice(expected.length)));
 });
 await io.back();
 return Boolean(matched && await io.progress() && await io.capture());
}
export function confirmedNavigation(result) {
 return result?.ok && !result.resumed && typeof result.title==='string' && result.title.trim() ? {...result,bookTitle:result.title} : result;
}
export function isSuccessfulUiDump(output) {
 const {stdout,stderr}=typeof output==='string'?{stdout:output,stderr:''}:output||{};
 return !String(stderr||'').trim() && /^UI hierchary dumped to: \/sdcard\/window\.xml\s*$/m.test(String(stdout||''));
}

// Text proximity alone also matches dialogs and security notices. Require both
// a book-list page marker and independently identified book-card fields.
export function extractReliableCandidates(nodes) {
 if (nodes.some(n=>/^(?:账号安全(?:提示|验证)?|安全验证|登录验证|隐私协议|用户协议|授权登录)$/.test((n.text||'').trim()))) return [];
 if (!nodes.some(n=>/^(书城|推荐|精选)$/.test(n.text||''))) return [];
 const titles=nodes.filter(n=>/^com\.dragon\.read:id\/(?:book_title|book_name)$/.test(n.id||''));
 const descriptions=nodes.filter(n=>/^com\.dragon\.read:id\/(?:book_description|book_desc|book_abstract)$/.test(n.id||''));
 const identified=extractCandidates(titles,descriptions);
 // MuMu's Compose cards expose obfuscated IDs. Trust only the observed card
 // structure: a clickable child of the book ComposeView, with direct score,
 // title and description siblings. Never pair text across cards.
 const cards=nodes.filter(n=>n.className==='android.view.View' && n.clickable && n.enabled && n.packageName==='com.dragon.read' && n.parent?.parent?.id==='com.dragon.read:id/f9y' && n.parent.parent.className==='androidx.compose.ui.platform.ComposeView');
 const compose=[];
 for(const card of cards) {
  const fields=nodes.filter(n=>n.parent===card && n.className==='android.widget.TextView' && n.packageName==='com.dragon.read' && n.enabled && n.text);
  if(fields.length!==3 || !/^\d(?:\.\d)?分$/.test(fields[0].text))continue;
  const [score,title,description]=fields;
  const parse=b=>{const m=/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(b||'');return m&&{x1:+m[1],y1:+m[2],x2:+m[3],y2:+m[4]};};
  const c=parse(card.bounds), s=parse(score.bounds), t=parse(title.bounds), d=parse(description.bounds);
  const inside=(a,b)=>a&&b&&b.x2>b.x1&&b.y2>b.y1&&b.x1>=a.x1&&b.y1>=a.y1&&b.x2<=a.x2&&b.y2<=a.y2;
  if(!inside(c,s)||!inside(c,t)||!inside(c,d)||s.y2>t.y1||t.y2>d.y1||d.y1-t.y2>=70||Math.abs(t.x1-d.x1)>=35)continue;
  compose.push(...extractCandidates([title],[description]));
 }
 return [...new Map([...identified,...compose].map(c=>[c.title,c])).values()].slice(0,8);
}
// Preserve ancestry so obfuscated Compose fields cannot be paired across cards.
const parseNodes=xml=>{
 const nodes=[],stack=[];
 const decode=s=>s.replace(/&(?:amp|lt|gt|quot|apos);/g,x=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"})[x]);
 for(const match of String(xml).matchAll(/<\/?node\b[^>]*>/g)) {
  const tag=match[0]; if(tag.startsWith('</')){stack.pop();continue;}
  const attr=name=>decode(new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag)?.[1]||'');
  const n={text:attr('text'),id:attr('resource-id'),bounds:attr('bounds'),className:attr('class'),packageName:attr('package'),clickable:attr('clickable')==='true',enabled:attr('enabled')==='true',parent:stack.at(-1)};
  nodes.push(n);if(!tag.endsWith('/>'))stack.push(n);
 }
 return nodes;
};

// Kill the entire isolated process group, then wait for close before releasing
// the mutex; a timeout must never leave an ADB subprocess using the device.
function boundedAdb(serial,args,signal,timeoutMs=7000) {
 return new Promise((resolve,reject)=>{
  if(signal?.aborted)return reject(new Error('capture cancelled'));
  const child=spawn('adb',['-s',serial,...args],{detached:true,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='',failed=false;
  const kill=()=>{failed=true;try{process.kill(-child.pid,'SIGKILL')}catch{}};
  const timer=setTimeout(kill,timeoutMs);
  // The flock helper can die while an ADB command is in flight. Stop the
  // entire process group promptly rather than continuing after lease loss.
  const leaseCheck=setInterval(()=>{try{assertPhoneLock()}catch{kill()}},100);
  signal?.addEventListener('abort',kill,{once:true});
  const collect=(which,chunk)=>{if(which==='out')stdout+=chunk;else stderr+=chunk;if(stdout.length+stderr.length>4*1024*1024)kill();};
  child.stdout.on('data',c=>collect('out',c)); child.stderr.on('data',c=>collect('err',c));
  child.on('error',()=>{failed=true});
  child.on('close',code=>{clearTimeout(timer);clearInterval(leaseCheck);signal?.removeEventListener('abort',kill);if(failed||code!==0)reject(new Error('capture unavailable'));else resolve({stdout,stderr});});
 });
}
function readerInspectionIO(adb) {
 const focus=async()=>String((await adb('shell','dumpsys','window')).stdout).split('\n').find(x=>x.includes('mCurrentFocus'))||'';
 const inReader=async()=>/com\.dragon\.read\/[^\s]*ReaderActivity/.test(await focus());
 const dump=async()=>{if(!await inReader())return [];const result=await adb('shell','uiautomator','dump','/sdcard/window.xml');if(!isSuccessfulUiDump(result))return [];const xml=(await adb('exec-out','cat','/sdcard/window.xml')).stdout;if(!await inReader())return [];return parseNodes(xml);};
 const tap=async(x,y)=>{if(!await inReader())return false;await adb('shell','input','tap',String(x),String(y));await delay(1200);return true;};
 return {dump,catalog:dump,progress:async()=>parseReaderProgress((await dump()).map(n=>n.text)),tap,
  back:async()=>{if(await inReader()){await adb('shell','input','keyevent','4');await delay(1200);}},
  showControls:async()=>{const size=(await adb('shell','wm','size')).stdout;const sizes=[...size.matchAll(/(?:Override|Physical) size:\s*(\d+)x(\d+)/g)];const s=sizes.at(-1);if(s)await tap(Math.round(+s[1]*.5),Math.round(+s[2]*.5));}};
}
export async function observeFanqieCandidates({serial,signal}) {
 if (!serial || serial !== process.env.PHONE_SERIAL) throw new Error('device unavailable');
 const adb=async(...args)=>{assertPhoneLock();if(serial!==process.env.PHONE_SERIAL)throw new Error('device unavailable');return boundedAdb(serial,args,signal);};
 const focus=async()=>String((await adb('shell','dumpsys','window')).stdout).split('\n').find(x=>x.includes('mCurrentFocus'))||'';
 // Reader identity inspection may temporarily open its catalogue under the lock.
 const f=await focus();
 if (!f.includes('com.dragon.read/')) return {ok:false};
 if (/com\.dragon\.read\/[^\s]*ReaderActivity/.test(f)) {
  const candidate=await inspectCurrentReader(readerInspectionIO(adb));
  return {ok:true,candidates:candidate?[candidate]:[],observedAt:new Date().toISOString()};
 }
 const result=await adb('shell','uiautomator','dump','/sdcard/window.xml');
 const observedAt=new Date().toISOString();
 if (!isSuccessfulUiDump(result)) return {ok:false};
 const xml=(await adb('exec-out','cat','/sdcard/window.xml')).stdout;
 if (!(await focus()).includes('com.dragon.read/')) return {ok:false};
 return {ok:true,candidates:extractReliableCandidates(parseNodes(xml)),observedAt};
}

export async function openAndSelectFanqie({serial,brain}) {
 if(!serial||serial!==process.env.PHONE_SERIAL)throw new Error('专属设备未配置或不匹配');
 const adb=async(...args)=>{assertPhoneLock();if(serial!==process.env.PHONE_SERIAL)throw new Error('device unavailable');const result=await exec('adb',['-s',serial,...args],{timeout:15000,maxBuffer:4*1024*1024});if(args.includes('uiautomator'))return result;return result.stdout;};
 const focus=async()=>String(await adb('shell','dumpsys','window')).split('\n').find(x=>x.includes('mCurrentFocus'))||'';
 const dump=async()=>{if(!(await focus()).includes('com.dragon.read/'))return [];const result=await adb('shell','uiautomator','dump','/sdcard/window.xml');if(!isSuccessfulUiDump(result))return [];const xml=await adb('exec-out','cat','/sdcard/window.xml');if(!(await focus()).includes('com.dragon.read/'))return [];return parseNodes(xml);};
 const tap=async(x,y)=>{if(!(await focus()).includes('com.dragon.read/'))return false;await adb('shell','input','tap',String(x),String(y));await delay(1200);return true;};
 const verify=async item=>verifyOpenedReader(item,{progress:()=>getReaderProgress(serial),capture:()=>captureFanqiePage(serial),dump,tap,catalog:dump,back:async()=>{if(!(await focus()).includes('com.dragon.read/'))return;await adb('shell','input','keyevent','4');await delay(1200)},showControls:async()=>{const size=await adb('shell','wm','size');const m=/(?:Override|Physical) size:\s*(\d+)x(\d+)/g;const sizes=[...size.matchAll(m)];const s=sizes.at(-1);if(s)await tap(Math.round(+s[1]*.5),Math.round(+s[2]*.5));}});
 let f=await focus();if(!f.includes('com.dragon.read/')){if(!/launcher/i.test(f))return {ok:false,reason:'other-app-active'};await adb('shell','monkey','-p','com.dragon.read','-c','android.intent.category.LAUNCHER','1');await delay(4000)}
 if(await getReaderProgress(serial)) {
  const returned=await returnReaderToBookstore({
   snapshot:async()=>{const current=await focus();const nodes=await dump();return {focus:current,nodes,progress:parseReaderProgress(nodes.map(n=>n.text))};},
   tap:async(x,y)=>{if(!/com\.dragon\.read\/[^\s]*ReaderActivity/.test(await focus()))return false;return tap(x,y);},
   bookstore:async()=>{const current=await focus();if(!/com\.dragon\.read\/[^\s]*MainFragmentActivity/.test(current))return false;const nodes=await dump();return nodes.some(n=>n.text==='书城'&&n.packageName==='com.dragon.read')&&extractReliableCandidates(nodes).length>0;}
  });
  if(!returned)return {ok:false,reason:'navigation-failed'};
 }
 return confirmedNavigation(await selectAndOpen({observe:async()=>extractReliableCandidates(await dump()),choose:c=>chooseCandidate(brain,c),click:async item=>tap(item.x,item.y),enter:async item=>{
  if(await getReaderProgress(serial))return verify(item);
  const nodes=await dump();if(!detailMatchesCandidate(item,nodes)||!nodes.some(n=>n.text==='左滑开始阅读'))return false;
  const size=await adb('shell','wm','size');const sizes=[...size.matchAll(/(?:Override|Physical) size:\s*(\d+)x(\d+)/g)];const m=sizes.at(-1);if(!m||!(await focus()).includes('com.dragon.read/'))return false;const w=+m[1],h=+m[2];await adb('shell','input','swipe',String(Math.round(w*.77)),String(Math.round(h*.57)),String(Math.round(w*.23)),String(Math.round(h*.57)),'450');await delay(2500);return verify(item);
 }}));
}
