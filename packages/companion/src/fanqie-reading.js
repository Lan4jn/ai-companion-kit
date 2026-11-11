import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const exec = promisify(execFile);

export function parseReaderProgress(texts) {
 const values=Array.isArray(texts)?texts:[];
 const chapter=values.find(s=>/^第.{1,12}章/.test(s)) || null;
 const match=values.map(s=>/^(\d{1,7})\/(\d{1,7})$/.exec(s)).find(Boolean);
 if(!match)return null;
 const page=Number(match[1]),total=Number(match[2]);
 return page>0 && page<=total ? {chapter,page,total} : null;
}
export function isForwardProgress(before,after) {
 return Boolean(before && after && before.total===after.total && after.page===before.page+1);
}

export async function getReaderProgress(serial) {
 if (!serial || serial !== process.env.PHONE_SERIAL) throw new Error('未配置或不匹配专用设备');
 const {stdout:focus}=await exec('adb',['-s',serial,'shell','dumpsys','window'],{timeout:8000,maxBuffer:4*1024*1024});
 if (!focus.split('\n').some(x=>x.includes('mCurrentFocus') && /com\.dragon\.read\/[^\s]*ReaderActivity/.test(x))) return null;
 await exec('adb',['-s',serial,'shell','uiautomator','dump','/sdcard/window.xml'],{timeout:12000});
 const {stdout:xml}=await exec('adb',['-s',serial,'exec-out','cat','/sdcard/window.xml'],{timeout:8000,maxBuffer:4*1024*1024});
 const texts=[...xml.matchAll(/\btext="([^"]*)"/g)].map(m=>m[1].replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>'));
 const {stdout:after}=await exec('adb',['-s',serial,'shell','dumpsys','window'],{timeout:8000,maxBuffer:4*1024*1024});
 if (!after.split('\n').some(x=>x.includes('mCurrentFocus') && /com\.dragon\.read\/[^\s]*ReaderActivity/.test(x))) return null;
 return parseReaderProgress(texts);
}

// OCR is untrusted and can be inaccurate; caller must preserve this provenance.
export function extractReadingPage({foreground, ocr}) {
  if (!/com\.dragon\.read\/[^\s]*ReaderActivity/.test(String(foreground))) return null;
  const text = String(ocr || '').trim();
  if ((text.match(/[\u4e00-\u9fff]/g) || []).length < 65) return null;
  return {text, source:'番茄小说屏幕OCR（可能存在识别错误）', fingerprint:createHash('sha256').update(text).digest('hex')};
}

// Explicit serial only; no ADB fallback to any other device.
export async function captureFanqiePage(serial) {
  if (!serial || serial !== process.env.PHONE_SERIAL) throw new Error('未配置或不匹配专用设备');
  const {stdout:focus} = await exec('adb',['-s',serial,'shell','dumpsys','window'],{timeout:8000,maxBuffer:4*1024*1024});
  const foreground = focus.split('\n').find(x=>x.includes('mCurrentFocus')) || '';
  if (!/com\.dragon\.read\/[^\s]*ReaderActivity/.test(foreground)) return null;
  const {stdout:png} = await exec('adb',['-s',serial,'exec-out','screencap','-p'],{encoding:'buffer',timeout:12000,maxBuffer:12*1024*1024});
  const dir = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(),'fanqie-'));
  const file = path.join(dir,'screen.png');
  try { await fs.writeFile(file,png,{mode:0o600}); const {stdout:ocr} = await exec('tesseract',[file,'stdout','-l','chi_sim+eng'],{timeout:20000,maxBuffer:1024*1024});
    const {stdout:after}=await exec('adb',['-s',serial,'shell','dumpsys','window'],{timeout:8000,maxBuffer:4*1024*1024});
    if (!after.includes(foreground.trim())) return null;
    return extractReadingPage({foreground,ocr});
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
}
