import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {assertPhoneLock} from './phone-mutex.js';

const exec=promisify(execFile);
const packageName='com.dragon.read';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// Resource IDs must be established independently from the actual app. This
// driver does not discover or infer what a control means. The caller owns the
// phone mutex for the entire social operation, not merely for this tap.
export function createFanqieSocialControlDriver({serial,configuredSerial=process.env.PHONE_SERIAL,openResourceId,panelResourceId,run=exec}={}) {
 const validId=id=>typeof id==='string' && /^com\.dragon\.read:id\/[A-Za-z0-9_]+$/.test(id);
 if(typeof serial!=='string'||!serial.trim()||serial!==configuredSerial||!validId(openResourceId)||!validId(panelResourceId)||openResourceId===panelResourceId||typeof run!=='function') throw new Error('需要专属设备和已确认的不同控件ID');
 const adb=async(...args)=>{assertPhoneLock();return String((await run('adb',['-s',serial,...args],{encoding:'utf8',timeout:15000,maxBuffer:8*1024*1024})).stdout);};
 const foreground=async()=>{
  const data=await adb('shell','dumpsys','activity','activities');
  const lines=data.split(/\r?\n/).filter(line=>/mResumedActivity|topResumedActivity/.test(line));
  const packages=lines.map(line=>line.match(/\s([\w.]+)\/[\w.$]+/)?.[1]);
  return packages.length>0 && packages.every(name=>name===packageName);
 };
 const snapshot=async()=>{
  if(!await foreground())return null;
  const xml=await adb('shell','uiautomator','dump','/dev/tty');
  if(!xml.includes('<hierarchy')||!xml.includes('</hierarchy>')||/用户协议|隐私政策|同意并|登录|验证码|privacy policy|sign\s*in|terms of service/i.test(xml))return null;
  if(!await foreground())return null;
  return [...xml.matchAll(/<node\s+[^>]*\/?\s*>/g)].map(m=>m[0]);
 };
 const find=(nodes,id)=>nodes?.filter(node=>node.includes(`resource-id="${id}"`))||[];
 const bounds=node=>{
  if(!/\bclickable="true"/.test(node)||!/\benabled="true"/.test(node))return null;
  const m=/\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node);
  if(!m)return null;
  const a=m.slice(1).map(Number);
  return a[2]>a[0]&&a[3]>a[1]&&a[2]<=10000&&a[3]<=10000?a:null;
 };
 return {async openComments(){
  const before=await snapshot();
  if(!before||find(before,panelResourceId).length)return {ok:false};
  const first=find(before,openResourceId);if(first.length!==1)return {ok:false};
  const b=bounds(first[0]);if(!b)return {ok:false};
  const next=await snapshot();if(!next||find(next,panelResourceId).length)return {ok:false};
  const second=find(next,openResourceId);if(second.length!==1)return {ok:false};
  const c=bounds(second[0]);if(!c||c.some((value,i)=>value!==b[i])||!await foreground())return {ok:false};
  await adb('shell','input','tap',String(Math.floor((c[0]+c[2])/2)),String(Math.floor((c[1]+c[3])/2)));
  await wait(800);
  const after=await snapshot();
  return {ok:Boolean(after&&find(after,panelResourceId).length===1)};
 }};
}
