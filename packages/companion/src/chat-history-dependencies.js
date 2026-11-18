import {createHmac} from 'node:crypto';

// Domain-separated keyed commitments; no plaintext history is serialized.
export function historyDependencies(key, destination, rows) {
 if (!Buffer.isBuffer(key) || key.length!==32 || typeof destination!=='string' || !Array.isArray(rows) || rows.length>20) throw Error('invalid history provenance');
 return {version:1, commitments:rows.map(row=>createHmac('sha256',key).update('chat-history-dependency-v1\0').update(JSON.stringify([destination,row])).digest('hex'))};
}
export function validHistoryDependencies(value) {
 return !!(value && Object.keys(value).sort().join(',')==='commitments,version' && value.version===1 && Array.isArray(value.commitments) && value.commitments.length<=20 && value.commitments.every(x=>typeof x==='string' && /^[a-f0-9]{64}$/.test(x)));
}
