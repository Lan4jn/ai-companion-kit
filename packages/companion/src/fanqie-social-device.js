import {observeFanqiePublication} from './fanqie-publication-observer.js';
import {assertPhoneLock} from './phone-mutex.js';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {inspectFanqieEvidence} from './fanqie-social-evidence.js';
const exec=promisify(execFile);

// The available UI evidence exposes neither a stable thread/account identity
// nor a complete baseline. Never turn UI labels into publication credentials.
export function createFanqiePublicationDeviceIO({serial,configuredSerial=process.env.PHONE_SERIAL,run}={}) {
 if(typeof serial!=='string'||!serial.trim()||serial!==configuredSerial) throw new Error('专属设备未配置或不匹配');
 return {
  async observeEvidence(){
   const adb=async(...args)=>{assertPhoneLock();return await (run||exec)('adb',['-s',serial,...args],{encoding:'utf8',timeout:20000,maxBuffer:8*1024*1024});};
   const activity=async()=>{const r=await adb('shell','dumpsys','activity','activities');const a=[...String(r.stdout||'').matchAll(/topResumedActivity=.*?\s([\w.]+\/[\w.$]+)/g)].map(x=>x[1]);return a.length===1?a[0]:null;};
   const first=await activity();
   if(!['com.dragon.read/.social.profile.ProfileActivity','com.dragon.read/com.dragon.community.impl.detail.page.CSSBookCommentDetailsActivity'].includes(first))return {profile:null,review:null};
   const dump=await adb('shell','uiautomator','dump','/sdcard/fanqie-social-evidence.xml');
   if(!/UI hierchary dumped to: \/sdcard\/fanqie-social-evidence\.xml/.test(String(dump.stdout||''))||/error/i.test(String(dump.stderr||'')))return {profile:null,review:null};
   const xml=String((await adb('exec-out','cat','/sdcard/fanqie-social-evidence.xml')).stdout||'');
   if(await activity()!==first)return {profile:null,review:null};
   return inspectFanqieEvidence({activity:first,xml});
  },
  async observe(){
   const seen=await observeFanqiePublication({serial,configuredSerial,...(run?{run}:{})});
   return {composer:seen.composer,authenticated:false,accountId:null,target:null,text:null,submitEnabled:false,baselineComplete:false,visibleCommentIds:[]};
  },
  async fill(){assertPhoneLock();throw new Error('发表身份和目标证据不可用');},
  async submit(){assertPhoneLock();throw new Error('发表身份和目标证据不可用');},
  async readBack(){assertPhoneLock();return null;}
 };
}
