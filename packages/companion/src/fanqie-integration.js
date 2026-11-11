import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createFanqieRunner } from './fanqie-runner.js';
import { createReadingScheduler } from './fanqie-scheduler.js';
import { openAndSelectFanqie } from './fanqie-device-navigation.js';
import { getReaderProgress, captureFanqiePage } from './fanqie-reading.js';
import { decideReading, runReadingStep, verifiedTurn } from './fanqie-autonomous.js';
import { saveFanqieMemory } from './fanqie-session.js';
import { phoneMutex } from './phone-mutex.js';

const exec = promisify(execFile);
async function adb(serial, ...args) {
 if (!serial || serial !== process.env.PHONE_SERIAL) throw new Error('专用设备未配置或不匹配');
 return (await exec('adb', ['-s', serial, ...args], {timeout:12000, maxBuffer:4*1024*1024})).stdout;
}
async function isOnline(serial) {
 try { return (await adb(serial, 'get-state')).trim() === 'device'; }
 catch { return false; }
}
async function turnPage(serial) {
 const focus = await adb(serial, 'shell', 'dumpsys', 'window');
 if (!focus.split('\n').some(s => s.includes('mCurrentFocus') && /com\.dragon\.read\/[^\s]*ReaderActivity/.test(s))) throw new Error('reader-not-active');
 const sizes = [...(await adb(serial, 'shell', 'wm', 'size')).matchAll(/(?:Override|Physical) size:\s*(\d+)x(\d+)/g)];
 const size = sizes.at(-1);
 if (!size) throw new Error('screen-size-unavailable');
 const w=Number(size[1]), h=Number(size[2]);
 await adb(serial,'shell','input','swipe',String(Math.round(w*.8)),String(Math.round(h*.55)),String(Math.round(w*.2)),String(Math.round(h*.55)),'400');
 await new Promise(resolve => setTimeout(resolve, 1200));
}

// Constructing this integration does not start the scheduler or contact a device.
export function createFanqieIntegration({serial, brain, memoryDir, want, mutex=phoneMutex,
 maxSteps=5, intervalMs=45*60*1000, online=isOnline, navigate=openAndSelectFanqie,
 progress=getReaderProgress, capture=captureFanqiePage, save=saveFanqieMemory, gesture=turnPage}={}) {
 if (!serial || !brain || typeof brain.complete !== 'function' || !memoryDir || typeof want !== 'function') throw new TypeError('serial, brain, memoryDir and want are required');
 if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 100) throw new RangeError('maxSteps must be between 1 and 100');
 if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new RangeError('intervalMs must be positive');
 const checked = async (fn,...args) => { if (!await online(serial)) throw new Error('device-offline'); try{return await fn(...args);}catch(e){if (/device (?:offline|not found)|no devices?\b/i.test(`${e?.message || ''} ${e?.stderr || ''}`)) throw new Error('device-offline');throw e;} };
 const getProgress=()=>checked(progress,serial);
 const getPage=()=>checked(capture,serial);
 const run=createFanqieRunner({
  exclusive:fn=>mutex.tryBackground(fn),
  navigate:()=>checked(navigate,{serial,brain}),
  read:async()=>{
   for(let i=0;i<maxSteps;i++) {
    const result=await runReadingStep({
     observe:async()=>{const p=await getProgress(); if(!p)return null; const page=await getPage(); const after=await getProgress(); return page?.source && page?.fingerprint && after && p.page===after.page && p.total===after.total && p.chapter===after.chapter ? {...page,progress:p} : null;},
     understand:text=>decideReading(brain,text), save:record=>save(memoryDir,record),
     turn:async expected=> i===maxSteps-1 ? {ok:true,progress:expected} : verifiedTurn({getProgress:async()=>{const p=await getProgress();if(p && p.chapter!==expected.chapter)throw new Error('chapter-changed');return p;},capture:getPage,expected,gesture:()=>checked(gesture,serial)})
    });
    if(!result.ok || result.stopped) return result;
   }
   return {ok:true,stopped:true,reason:'step-limit'};
  }
 });
 const safeRun=async()=>{try{return await run();}catch(e){return {ok:false,reason:['device-offline','chapter-changed'].includes(e?.message)?e.message:'integration-error',error:String(e?.message || e)};}};
 const scheduler=createReadingScheduler({want,run:safeRun,intervalMs});
 return {run:safeRun,scheduler};
}
