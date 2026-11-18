import dns from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';

const blocked = new net.BlockList();
for (const [ip, bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) blocked.addSubnet(ip,bits,'ipv4');
// Restrict IPv6 to global unicast, excluding protocol assignments and documentation.
const special6 = new net.BlockList();
for (const [ip,bits] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]]) special6.addSubnet(ip,bits,'ipv6');
const global6 = new net.BlockList(); global6.addSubnet('2000::',3,'ipv6');
export function isPublicAddress(ip) {
  const family = net.isIP(ip);
  if (family === 4) return !blocked.check(ip,'ipv4');
  if (family === 6) return global6.check(ip,'ipv6') && !special6.check(ip,'ipv6');
  return false;
}
function safeUrl(value) {
  const url = new URL(value);
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new Error('unsafe URL');
  const host = url.hostname.replace(/^\[|\]$/g,'');
  if (net.isIP(host) && !isPublicAddress(host)) throw new Error('non-public address');
  return url;
}
function request(url, address, signal, maxBytes) {
  return new Promise((resolve,reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.get(url, { signal, headers: { 'user-agent':'Mozilla/5.0 (compatible; WebEvidence/1.0)', accept:'text/html,text/plain' }, lookup: (_host,opts,cb) => opts.all ? cb(null,[address]) : cb(null,address.address,address.family) }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400) { res.destroy(); return resolve({ redirect: res.headers.location || '' }); }
      if (res.statusCode !== 200) { res.destroy(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      if (!/^(text\/html|text\/plain)(?:\s*;|\s*$)/i.test(res.headers['content-type'] || '')) { res.destroy(); return reject(new Error('unsupported content type')); }
      if (Number(res.headers['content-length']) > maxBytes) { res.destroy(); return reject(new Error('response too large')); }
      let size=0; const chunks=[];
      res.on('data', chunk => { size += chunk.length; if (size > maxBytes) res.destroy(new Error('response too large')); else chunks.push(chunk); });
      res.on('error',reject); res.on('end',()=>resolve({body:Buffer.concat(chunks).toString('utf8'), type:res.headers['content-type']}));
    });
    req.on('error',reject);
  });
}
export async function readWebEvidence(input, { timeoutMs = 8000, maxBytes = 512000, maxRedirects = 3 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(()=>controller.abort(), timeoutMs); timeout.unref();
  try {
    let url = safeUrl(input);
    for (let i=0; i<=maxRedirects; i++) {
      const host=url.hostname.replace(/^\[|\]$/g,'');
      const addresses = await Promise.race([dns.lookup(host,{all:true,verbatim:true}), new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(new Error('timeout')),{once:true}))]);
      if (!addresses.length || addresses.some(a=>!isPublicAddress(a.address))) throw new Error('DNS returned non-public address');
      const result=await request(url,addresses[0],controller.signal,maxBytes);
      if (result.redirect !== undefined) { if (!result.redirect || i===maxRedirects) throw new Error('invalid or excessive redirect'); url=safeUrl(new URL(result.redirect,url).href); continue; }
      let text=result.body;
      if (/^text\/html/i.test(result.type)) text=text.replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,' ').replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/gi,' ').replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>');
      text=text.replace(/\s+/g,' ').trim();
      if (text.length < 30) throw new Error('insufficient page text');
      return { url:url.href, text:text.slice(0,12000), sha256:createHash('sha256').update(text).digest('hex'), fetchedAt:Date.now() };
    }
  } finally { clearTimeout(timeout); }
}
