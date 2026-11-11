import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {extractCandidates,chooseCandidate,detailMatchesCandidate} from './fanqie-select.js';
import {selectAndOpen} from './fanqie-navigation.js';
import {getReaderProgress,captureFanqiePage} from './fanqie-reading.js';
const exec=promisify(execFile), delay=ms=>new Promise(r=>setTimeout(r,ms));
const center = bounds => { const m=/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(bounds||''); return m&&+m[3]>+m[1]&&+m[4]>+m[2] ? [Math.round((+m[1]+ +m[3])/2),Math.round((+m[2]+ +m[4])/2)] : null; };

// The reader and details share an activity. Verify title in the reader's catalog,
// then close the catalog and recheck the actual reading page.
export async function verifyOpenedReader(item,io) {
 if (!await io.progress() || !await io.capture()) return false;
 let nodes=await io.dump(); let menu=nodes.find(n=>n.text==='目录'&&center(n.bounds));
 if(!menu && io.showControls){await io.showControls();nodes=await io.dump();menu=nodes.find(n=>n.text==='目录'&&center(n.bounds));}
 if(!menu)return false;
 const [x,y]=center(menu.bounds); if(!await io.tap(x,y))return false;
 const catalog=await io.catalog();
 const isCatalog=catalog.some(n=>n.text==='目录')&&catalog.some(n=>/^(连载至|已完结|共\d+章)/.test(n.text));
 if(!isCatalog)return false;
 const matched=catalog.some(n=>n.text===item.title);
 await io.back();
 return Boolean(matched && await io.progress() && await io.capture());
}
export async function openAndSelectFanqie({serial,brain}) {
 if(!serial||serial!==process.env.PHONE_SERIAL)throw new Error('专属设备未配置或不匹配');
 const adb=async(...args)=>(await exec('adb',['-s',serial,...args],{timeout:15000,maxBuffer:4*1024*1024})).stdout;
 const focus=async()=>String(await adb('shell','dumpsys','window')).split('\n').find(x=>x.includes('mCurrentFocus'))||'';
 const dump=async()=>{if(!(await focus()).includes('com.dragon.read/'))return [];await adb('shell','uiautomator','dump','/sdcard/window.xml');const xml=await adb('exec-out','cat','/sdcard/window.xml');return [...xml.matchAll(/<node\s[^>]*>/g)].map(m=>({text:(/\btext="([^"]*)"/.exec(m[0])||[])[1]?.replace(/&amp;/g,'&')||'',bounds:(/\bbounds="([^"]*)"/.exec(m[0])||[])[1]||''}));};
 const tap=async(x,y)=>{if(!(await focus()).includes('com.dragon.read/'))return false;await adb('shell','input','tap',String(x),String(y));await delay(1200);return true;};
 const verify=async item=>verifyOpenedReader(item,{progress:()=>getReaderProgress(serial),capture:()=>captureFanqiePage(serial),dump,tap,catalog:dump,back:async()=>{if(!(await focus()).includes('com.dragon.read/'))return;await adb('shell','input','keyevent','4');await delay(1200)},showControls:async()=>{const size=await adb('shell','wm','size');const m=/(?:Override|Physical) size:\s*(\d+)x(\d+)/g;const sizes=[...size.matchAll(m)];const s=sizes.at(-1);if(s)await tap(Math.round(+s[1]*.5),Math.round(+s[2]*.5));}});
 let f=await focus();if(!f.includes('com.dragon.read/')){if(!/launcher/i.test(f))return {ok:false,reason:'other-app-active'};await adb('shell','monkey','-p','com.dragon.read','-c','android.intent.category.LAUNCHER','1');await delay(4000)}
 if(await getReaderProgress(serial))return {ok:true,resumed:true};
 return selectAndOpen({observe:async()=>extractCandidates(await dump()),choose:c=>chooseCandidate(brain,c),click:async item=>tap(item.x,item.y),enter:async item=>{
  if(await getReaderProgress(serial))return verify(item);
  const nodes=await dump();if(!detailMatchesCandidate(item,nodes)||!nodes.some(n=>n.text==='左滑开始阅读'))return false;
  const size=await adb('shell','wm','size');const sizes=[...size.matchAll(/(?:Override|Physical) size:\s*(\d+)x(\d+)/g)];const m=sizes.at(-1);if(!m||!(await focus()).includes('com.dragon.read/'))return false;const w=+m[1],h=+m[2];await adb('shell','input','swipe',String(Math.round(w*.77)),String(Math.round(h*.57)),String(Math.round(w*.23)),String(Math.round(h*.57)),'450');await delay(2500);return verify(item);
 }});
}
