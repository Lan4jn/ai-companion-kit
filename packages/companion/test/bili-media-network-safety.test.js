import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as media from '../src/bili-media-download.js';
const secureBiliFetch = (...args) => { assert.equal(typeof media.secureBiliFetch, 'function'); return media.secureBiliFetch(...args); };

function transport(addresses, status=200) {
  const seen=[];
  const lookup=async()=>addresses;
  const request=(url, options, callback)=>{
    const req=new EventEmitter(); req.destroy=err=>req.emit('error',err); req.end=()=>{
      options.lookup(url.hostname, {}, (err,address,family)=>{
        seen.push({err,address,family,servername:options.servername,headers:options.headers});
        if(err) return req.emit('error',err);
        const response=new PassThrough(); response.statusCode=status; response.headers={}; callback(response); response.end('ok');
      });
    }; return req;
  };
  return {lookup,request,seen};
}
test('public DNS answer is pinned to the TLS connection with original hostname', async()=>{
 const io=transport([{address:'8.8.8.8',family:4}]);
 const r=await secureBiliFetch('https://cdn.bilivideo.com/a',io);
 assert.equal(r.ok,true); assert.equal(io.seen[0].address,'8.8.8.8'); assert.equal(io.seen[0].servername,'cdn.bilivideo.com');
});
test('CDN request identifies browser and never forwards account cookies', async()=>{
 const io=transport([{address:'8.8.8.8',family:4}]);
 await secureBiliFetch('https://cdn.bilivideo.com/a',io);
 assert.match(io.seen[0].headers['user-agent'], /Mozilla\/5\.0/);
 assert.equal(io.seen[0].headers.cookie, undefined);
});
test('rejects private, mapped and mixed DNS answers and redirects', async()=>{
 for(const addresses of [[{address:'127.0.0.1',family:4}], [{address:'::ffff:127.0.0.1',family:6}], [{address:'8.8.8.8',family:4},{address:'10.0.0.1',family:4}]]) {
   await assert.rejects(secureBiliFetch('https://cdn.bilivideo.com/a',transport(addresses)));
 }
 await assert.rejects(secureBiliFetch('https://cdn.bilivideo.com/a',transport([{address:'8.8.8.8',family:4}],302)));
});
