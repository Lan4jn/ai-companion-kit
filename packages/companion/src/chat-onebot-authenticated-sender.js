// Recovery-only sender: every HTTP request verifies TLS hostname, CA and a pinned
// leaf certificate before sending. This does not authenticate WS ingress.
import https from 'node:https';
import http from 'node:http';
import tls from 'node:tls';
import {createHash, timingSafeEqual} from 'node:crypto';
import {checkOutput, cleanAllToolArtifacts} from './safety.js';

const senders = new WeakMap();
export function isAuthenticatedOneBotSender(sender, ownerId) {
  return typeof ownerId === 'string' && /^[1-9]\d*$/.test(ownerId) && senders.has(sender) && senders.get(sender) === ownerId;
}
// Trust is the local operator's explicit choice, not cryptographic identity.
export function createTrustedLoopbackOneBotSender({url,ownerId,accessToken=''}={}) {
  let endpoint; try { endpoint=new URL(url); } catch { throw Error('invalid loopback endpoint'); }
  if (typeof url!=='string' || !/^http:\/\/127\.0\.0\.1(?::[0-9]+)?\/?$/.test(url) || endpoint.protocol!=='http:' || endpoint.hostname!=='127.0.0.1' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname!=='/' || typeof ownerId!=='string' || !/^[1-9]\d*$/.test(ownerId) || typeof accessToken!=='string' || /[\r\n]/.test(accessToken)) throw Error('invalid loopback endpoint');
  const sender=Object.freeze({send(destination,text) {
    if (destination!==`private:${ownerId}` || typeof text!=='string' || !text || Buffer.byteLength(text)>32768 || /\[CQ:/i.test(text) || cleanAllToolArtifacts(text)!==text || !checkOutput(text).ok) return Promise.resolve({ok:false,outcome:'permanent'});
    const body=JSON.stringify({user_id:ownerId,message:text});
    return new Promise(resolve=>{
      let finished=false; const done=result=>{if(!finished){finished=true;resolve(result);}};
      const req=http.request(new URL('/send_private_msg',endpoint),{method:'POST',agent:false,headers:{'content-type':'application/json','content-length':Buffer.byteLength(body),...(accessToken?{authorization:`Bearer ${accessToken}`}:{})}},res=>{
        const chunks=[];let size=0;
        res.on('data',chunk=>{size+=chunk.length;if(size>65536)req.destroy();else chunks.push(chunk);});
        res.on('error',()=>done({ok:false,outcome:'unknown'}));
        res.on('end',()=>{let j;try{j=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return done({ok:false,outcome:'unknown'});}
          if(res.statusCode>=200 && res.statusCode<300 && j?.status==='ok' && j.retcode===0) return done({ok:true,data:j});
          if(res.statusCode>=200 && res.statusCode<300 && j && (j.status==='failed' || (typeof j.retcode==='number' && j.retcode!==0))) return done({ok:false,outcome:'permanent'});
          done({ok:false,outcome:'unknown'});
        });
      });
      req.setTimeout(10000,()=>req.destroy());req.on('error',()=>done({ok:false,outcome:'unknown'}));req.end(body);
    });
  }});
  senders.set(sender,ownerId);return sender;
}
export function createAuthenticatedOneBotSender({url, ca, certificateSha256, ownerId, accessToken=''} = {}) {
  let endpoint;
  try { endpoint = new URL(url); } catch { throw Error('invalid authenticated endpoint'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/' || !Buffer.isBuffer(ca) || !ca.length || typeof certificateSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(certificateSha256) || typeof ownerId !== 'string' || !/^[1-9]\d*$/.test(ownerId) || typeof accessToken !== 'string' || /[\r\n]/.test(accessToken)) throw Error('invalid authenticated endpoint');
  const pin = Buffer.from(certificateSha256,'hex');
  const trustedCa=Buffer.from(ca);
  const sender=Object.freeze({send(destination,text) {
    if (destination !== `private:${ownerId}` || typeof text !== 'string' || !text || Buffer.byteLength(text)>32768 || /\[CQ:/i.test(text) || cleanAllToolArtifacts(text)!==text || !checkOutput(text).ok) return Promise.resolve({ok:false,outcome:'permanent'});
    const body=JSON.stringify({user_id:ownerId,message:text});
    return new Promise(resolve=>{
      let finished=false;
      const done=result=>{if(!finished){finished=true;resolve(result);}};
      const req=https.request(new URL('/send_private_msg',endpoint), {
        method:'POST',ca:trustedCa,rejectUnauthorized:true,agent:false,
        checkServerIdentity(host,cert) {
          const error=tls.checkServerIdentity(host,cert);
          if(error) return error;
          if(!cert.raw || !timingSafeEqual(createHash('sha256').update(cert.raw).digest(),pin)) return Error('certificate pin mismatch');
        },
        headers:{'content-type':'application/json','content-length':Buffer.byteLength(body),...(accessToken ? {authorization:`Bearer ${accessToken}`} : {})},
      },res=>{
        let data='',size=0;
        res.on('data',chunk=>{size+=chunk.length;if(size>65536)req.destroy();else data+=chunk.toString();});
        res.on('error',()=>done({ok:false,outcome:'unknown'}));
        res.on('end',()=>{
          let j;try{j=JSON.parse(data);}catch{return done({ok:false,outcome:'unknown'});}
          if(res.statusCode>=200 && res.statusCode<300 && j && j.status==='ok' && j.retcode===0) return done({ok:true,data:j});
          if(j && (j.status==='failed' || (typeof j.retcode==='number' && j.retcode!==0))) return done({ok:false,outcome:'permanent'});
          done({ok:false,outcome:'unknown'});
        });
      });
      req.setTimeout(10000,()=>req.destroy());
      req.on('error',()=>done({ok:false,outcome:'unknown'}));
      req.end(body);
    });
  }});
  senders.set(sender,ownerId);
  return sender;
}
