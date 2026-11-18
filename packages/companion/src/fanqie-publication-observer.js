import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {assertPhoneLock} from './phone-mutex.js';
import {inspectFanqieComposer} from './fanqie-social-composer.js';

const exec=promisify(execFile);
const detail='com.dragon.read/com.dragon.community.impl.detail.page.CSSBookCommentDetailsActivity';
const unknown=()=>({composer:false,login:'unknown',target:null,canPublish:false});

// Only reports observed UI. Neither composer controls nor visible text identify
// an authenticated account or a stable review. Caller must hold phoneMutex.
export async function observeFanqiePublication({serial,configuredSerial=process.env.PHONE_SERIAL,run=exec}={}) {
 if(typeof serial!=='string'||!serial.trim()||serial!==configuredSerial||typeof run!=='function') throw new Error('专属设备未配置或不匹配');
 const adb=async(...args)=>{assertPhoneLock();return String((await run('adb',['-s',serial,...args],{encoding:'utf8',timeout:20000,maxBuffer:8*1024*1024})).stdout);};
 const activity=async()=>{const s=await adb('shell','dumpsys','activity','activities');const all=[...s.matchAll(/topResumedActivity=.*?\s([\w.]+\/[\w.$]+)/g)].map(x=>x[1]);return all.length===1?all[0]:null;};
 if(await activity()!==detail)return unknown();
 const dump=await adb('shell','uiautomator','dump','/sdcard/fanqie-publication-observer.xml');
 if(!/UI hierchary dumped to: \/sdcard\/fanqie-publication-observer\.xml/.test(dump))return unknown();
 const xml=await adb('exec-out','cat','/sdcard/fanqie-publication-observer.xml');
 if(await activity()!==detail)return unknown();
 const {composer}=inspectFanqieComposer({activity:detail,xml});
 return {composer,login:'unknown',target:null,canPublish:false};
}
