import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { douyinRequestAllowed, installDouyinRequestGuard } from '../src/douyin-navigation-safety.js';

const asset = 'https://lf-douyin-pc-web.douyinstatic.com/obj/douyin-pc-web/ies/douyin_web/player-0.226966a4.js';
test('only observed static hosts and bounded asset paths are permitted', () => {
  for (const host of ['lf-douyin-pc-web.douyinstatic.com','lf-douyin-pc-web-back.douyinstatic.com','lf3-cdn-tos.bytegoofy.com']) {
    for (const path of ['/obj/douyin-pc-web/ies/douyin_web/player-0.226966a4.js','/obj/douyin-pc-web/ies/douyin_web/chunks/routes-Video-id-route.b8ce1884.css']) {
      assert.equal(douyinRequestAllowed(`https://${host}${path}`), true);
      assert.equal(douyinRequestAllowed(`https://${host}${path}`, true), false);
    }
  }
  for (const url of [asset+'?token=secret',asset+'#x',asset.replace('lf-douyin-pc-web.', 'evil.'),asset.replace('/obj/douyin-pc-web/', '/obj/other/'),asset.replace('player-0.226966a4.js','data.json'),asset.replace('player-0.226966a4.js','%2e%2e/secret.js'),asset.replace('player-0.226966a4.js','../secret.js'),asset.replace('https:', 'http:'),asset.replace('.com/', '.com.evil/'),asset.replace('.com/', '.com:444/')]) assert.equal(douyinRequestAllowed(url), false, url);
});

test('static fetch strips cookies and authorization and retains DNS pinning', async () => {
  const oldLookup = dns.lookup, oldRequest = https.request; let handler, observed;
  try {
    dns.lookup = async () => [{address:'8.8.8.8',family:4}];
    https.request = (url, options, cb) => {
      observed = options;
      const request = new EventEmitter(); request.end = () => { const response = new EventEmitter(); response.statusCode=200; response.headers={}; cb(response); response.emit('end'); }; return request;
    };
    await installDouyinRequestGuard({routeWebSocket: async () => {},route: async (_, fn) => {handler=fn;}});
    let fulfilled=false;
    await handler({request:()=>({url:()=>asset,isNavigationRequest:()=>false,method:()=> 'GET',allHeaders:async()=>({cookie:'session=secret',authorization:'Bearer secret','proxy-authorization':'secret',accept:'*/*'}),postDataBuffer:()=>null}),fulfill:async()=>{fulfilled=true;},abort:async()=>{}});
    assert.equal(fulfilled,true); assert.equal(observed.headers.cookie,undefined); assert.equal(observed.headers.authorization,undefined); assert.equal(observed.headers['proxy-authorization'],undefined); assert.equal(observed.headers.accept,'*/*');
    observed.lookup('ignored',{},(_e,address,family)=>{assert.equal(address,'8.8.8.8');assert.equal(family,4)});
  } finally {dns.lookup=oldLookup; https.request=oldRequest;}
});
