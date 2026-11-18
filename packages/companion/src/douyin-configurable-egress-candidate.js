// Candidate only: not wired to production. Routes must be independently audited.
import dns from 'node:dns/promises';
import net from 'node:net';
import https from 'node:https';
import {isPublicAddress} from './web-evidence.js';

const METHODS = new Set(['GET','HEAD','POST']);
const HEADERS = new Set(['accept','content-type','cookie','origin','referer']);
const validHost = h => typeof h === 'string' && h.length <= 253 && /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(h) && !net.isIP(h);
const validPath = p => typeof p === 'string' && p.length <= 1024 && /^\/(?:[A-Za-z0-9_.~!$&'()*+,;=:@/-])*$/.test(p) && !/(?:^|\/)\.{1,2}(?:\/|$)/.test(p);

export function createRestrictedEgress({hosts = [], routes = []} = {}) {
  if (!Array.isArray(hosts) || !Array.isArray(routes) || hosts.some(h => !validHost(h))) throw Error('invalid policy');
  const allowed = new Set(hosts);
  const rules = new Set();
  for (const r of routes) {
    if (!r || !allowed.has(r.host) || !METHODS.has(r.method) || !validPath(r.path)) throw Error('invalid route');
    rules.add(`${r.host}\n${r.method}\n${r.path}`);
  }
  function authorize(method, input) {
    if (!METHODS.has(method) || typeof input !== 'string' || input.length > 4096 || /[\\\x00-\x20\x7f]/.test(input)) return false;
    const m = /^https:\/\/([^/?#]+)([^?#]*)(?:\?[^#]*)?$/.exec(input);
    if (!m || !allowed.has(m[1]) || !validPath(m[2] || '/')) return false;
    try {
      const u = new URL(input);
      return u.hostname === m[1] && !u.port && !u.username && !u.password && !u.hash && u.pathname === (m[2] || '/') && rules.has(`${u.hostname}\n${method}\n${u.pathname}`);
    } catch { return false; }
  }
  async function resolve(host, lookup = dns.lookup) {
    if (!allowed.has(host)) throw Error('destination denied');
    const result = await lookup(host, {all:true,verbatim:true});
    if (!Array.isArray(result) || !result.length || result.some(x => !x || ![4,6].includes(x.family) || net.isIP(x.address) !== x.family || !isPublicAddress(x.address))) throw Error('unsafe DNS');
    return {address:result[0].address,family:result[0].family};
  }
  // Test hooks are trusted constructor caller inputs, never supplied by browser.
  async function request({url,method='GET',headers={},body}, {lookup,port=443,ca,timeoutMs=8000,maxBytes=1048576,maxRedirects=3,signal}={}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 4194304 || !Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 5 || !Number.isInteger(port) || port < 1 || port > 65535) throw Error('invalid limits');
    if (!headers || typeof headers !== 'object' || Array.isArray(headers)) throw Error('invalid headers');
    const outgoing = {'accept-encoding':'identity'};
    let headerSize=0;
    for (const [k,v] of Object.entries(headers)) {
      if (!HEADERS.has(k) || typeof v !== 'string' || /[\r\n\0]/.test(v)) throw Error('invalid header');
      headerSize += Buffer.byteLength(k)+Buffer.byteLength(v);
      if (headerSize > 8192) throw Error('headers too large');
      outgoing[k]=v;
    }
    if (body !== undefined && !Buffer.isBuffer(body)) throw Error('invalid body');
    if (body?.length > 4096 || (body?.length && method !== 'POST')) throw Error('body denied');
    const controller = new AbortController();
    const abort=()=>controller.abort();
    if (signal?.aborted) abort(); else signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(abort,timeoutMs);
    try {
      for (let hop=0;;hop++) {
        if (controller.signal.aborted || !authorize(method,url)) throw Error('request denied');
        const parsed=new URL(url);
        if (outgoing.origin && outgoing.origin !== parsed.origin) throw Error('origin denied');
        if (outgoing.referer && (!outgoing.referer.startsWith(parsed.origin+'/') || /[\\\x00-\x20\x7f]/.test(outgoing.referer))) throw Error('referer denied');
        const pinned=await Promise.race([resolve(parsed.hostname,lookup),new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(Error('timeout')),{once:true}))]);
        if (controller.signal.aborted) throw Error('cancelled');
        const response=await new Promise((accept,reject)=>{
          const req=https.request(parsed,{method,port,ca,agent:false,signal:controller.signal,servername:parsed.hostname,rejectUnauthorized:true,autoSelectFamily:false,family:pinned.family,lookup:(_h,o,cb)=>o.all?cb(null,[pinned]):cb(null,pinned.address,pinned.family),headers:outgoing},res=>{
            let size=0; const chunks=[];
            res.on('data',c=>{size+=c.length;if(size>maxBytes) res.destroy(Error('response too large')); else chunks.push(c);});
            res.on('error',()=>reject(Error('response failed'))); res.on('aborted',()=>reject(Error('response aborted')));
            res.on('end',()=>accept({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));
          });
          req.on('error',()=>reject(Error('transport failed'))); req.end(body);
        });
        if (![301,302,303,307,308].includes(response.status)) return response;
        if (method !== 'GET' && method !== 'HEAD') throw Error('unsafe redirect');
        if (hop >= maxRedirects || typeof response.headers.location !== 'string') throw Error('redirect denied');
        const location=response.headers.location;
        // Reject raw path ambiguity before WHATWG URL normalizes dot segments.
        if (/[\\\\\x00-\x20\x7f]/.test(location) || /%/.test(location.split('?')[0]) || /(?:^|\/)\.{1,2}(?:\/|[?#]|$)/.test(location.split('?')[0])) throw Error('redirect denied');
        const next=new URL(location,parsed);
        // Never carry cookies or other request headers across hosts.
        if (next.hostname !== parsed.hostname || !authorize(method,next.href)) throw Error('redirect denied');
        url=next.href;
      }
    } finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }
  return Object.freeze({authorize,resolve,request});
}
