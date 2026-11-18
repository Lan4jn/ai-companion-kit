// Offline candidate only: this validates a signed snapshot, not the provenance,
// authorization, revocation, or read-only behaviour of its issuer. Do not wire
// into live generation until an independently trusted issuer is implemented.
import {createHmac, timingSafeEqual} from 'node:crypto';

// Fixed application-authored persona, independent of signed snapshots, chat,
// web content, memory and role cards. It grants no capabilities.
export const DURABLE_TEXT_PERSONA = '你是小鱼。温和、有自己的喜好和态度；结合关系和语境自然交流。日常聊天简洁自然，认真问题解释清楚，不确定的事就说不确定，不要编造。';

const fields=['tenant','platform','type','session','user'];
const validScope=s=>s && typeof s==='object' && !Array.isArray(s) &&
 Object.keys(s).sort().join(',')===[...fields].sort().join(',') &&
 fields.every(k=>typeof s[k]==='string' && s[k].length>0 && s[k].length<=512 && s[k].trim()===s[k]);
const equalScope=(a,b)=>validScope(a) && validScope(b) && fields.every(k=>a[k]===b[k]);
const exactKeys=(obj,keys)=>obj && typeof obj==='object' && !Array.isArray(obj) && Object.keys(obj).sort().join(',')===[...keys].sort().join(',');

export function verifyDurableContext({enabled=false,key,scope,bytes,mac}={}) {
 const fail=()=>{throw Error('untrusted durable context');};
 if (enabled!==true || !Buffer.isBuffer(key) || key.length!==32 || !validScope(scope) || scope.platform!=='qq' || scope.type!=='private' || !/^[1-9]\d*$/.test(scope.user) || scope.session!==`private:${scope.user}` || !Buffer.isBuffer(bytes) || bytes.length>65536 || !Buffer.isBuffer(mac) || mac.length!==32) return fail();
 const expected=createHmac('sha256',key).update('durable-context-v1\0').update(bytes).digest();
 if (!timingSafeEqual(mac,expected)) return fail();
 let data;
 try {data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));} catch {return fail();}
 const now=Date.now();
 if (!exactKeys(data,['version','scope','expiresAt','role','memories']) || data.version!==1 || !equalScope(data.scope,scope) || !Number.isSafeInteger(data.expiresAt) || data.expiresAt<=now || data.expiresAt>now+60000 || typeof data.role!=='string' || !data.role.trim() || data.role.length>12000 || !Array.isArray(data.memories) || data.memories.length>3) return fail();
 if (data.memories.some(m=>!exactKeys(m,['scope','text']) || !equalScope(m.scope,scope) || typeof m.text!=='string' || !m.text.trim() || m.text.length>1200)) return fail();
 return Object.freeze({role:data.role,memories:Object.freeze(data.memories.map(m=>m.text))});
}
