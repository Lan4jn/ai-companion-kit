// Selector key is a distinct secret shared only with the trusted sender.
import {createHmac, timingSafeEqual} from 'node:crypto';
const keys='confirm,id,snapshot';
function valid(s) {
 return s && typeof s==='object' && !Array.isArray(s) && Object.keys(s).sort().join(',')===keys && s.confirm===true && typeof s.id==='string' && s.id.length>0 && s.id.length<=256 && /^[a-f0-9]{64}$/.test(s.snapshot);
}
function mac(key,s) {return createHmac('sha256',key).update('onebot-queue-selector-v1\0').update(JSON.stringify([s.id,s.snapshot,s.confirm])).digest();}
export function signBridgeSelector(key,s) {
 if(!Buffer.isBuffer(key) || key.length!==32 || !valid(s)) throw Error('invalid selector');
 return {...s,signature:mac(key,s).toString('hex')};
}
export function verifyBridgeSelector(key,s) {
 if(!Buffer.isBuffer(key) || key.length!==32 || !s || typeof s!=='object' || Array.isArray(s) || Object.keys(s).sort().join(',')!=='confirm,id,signature,snapshot' || typeof s.signature!=='string' || !/^[a-f0-9]{64}$/.test(s.signature)) return null;
 const selector={id:s.id,snapshot:s.snapshot,confirm:s.confirm};
 return valid(selector) && timingSafeEqual(Buffer.from(s.signature,'hex'),mac(key,selector)) ? selector : null;
}
