import test from 'node:test';
import assert from 'node:assert/strict';
import { createTiebaCandidateFactory } from '../src/tieba-login-integration.js';

function fixture({ ttlMs = 1000 } = {}) {
  let complete, closed = 0, reads = 0, identity = 'owner';
  const handoff = new Promise(resolve => { complete = resolve; });
  const disconnected = new AbortController();
  const context = { cookies: async () => [] };
  const openOwnerSession = async () => ({ context, signal: disconnected.signal, waitForCompletion: () => handoff, close: async () => { closed++; } });
  const verifyIdentity = async ctx => { assert.equal(ctx, context); return {state:'online',subject:identity}; };
  const createTransport = async ctx => { assert.equal(ctx, context); return { fetchBody: async()=>{}, close:async()=>{} }; };
  const factory = createTiebaCandidateFactory({ enabled:true, openOwnerSession, verifyIdentity, createTransport, ttlMs, listSource:{list:async()=>{reads++; return ['synthetic'];}} });
  return { c:factory(), complete, disconnected, get closed(){return closed}, get reads(){return reads}, set identity(v){identity=v} };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('explicit owner completion gates same-session read', async () => {
 const f=fixture(), start=f.c.provider.start(); await tick();
 assert.deepEqual(await f.c.provider.status(),{state:'unknown'});
 await assert.rejects(f.c.source.list({forum:'肥鱼避难所吧'}),/unavailable/);
 assert.equal(f.reads,0); f.complete();
 assert.deepEqual(await start,{state:'online'});
 assert.deepEqual(await f.c.source.list({forum:'肥鱼避难所吧'}),['synthetic']);
 f.identity='other'; assert.deepEqual(await f.c.provider.status(),{state:'unknown'});
 assert.equal(f.closed,1); await f.c.close();
});

test('completed handoff reads synthetic thread through same context and pinned fake transport', async () => {
 let finish, requests=0, closes=0;
 const ready=new Promise(r=>{finish=r});
 const context={cookies:async()=>[{name:'session',value:'synthetic-secret',domain:'tieba.baidu.com',secure:true,path:'/'}]};
 const html='<div class="forum-name-main">肥鱼避难所</div><div class="forum-name-suffix">吧</div><div class="center-content"><div class="image-text"><div class="pb-title">测试</div><div class="pb-content-wrap"><div tid="123">虚构帖子</div></div><div class="desc-info"><span class="post-num">2026-01-01</span></div></div></div>';
 const c=createTiebaCandidateFactory({enabled:true,openOwnerSession:async()=>({context,waitForCompletion:()=>ready,close:async()=>{closes++}}),verifyIdentity:async ctx=>{assert.equal(ctx,context);return {state:'online',subject:'synthetic-owner'}},listSource:{list:async()=>[]},transportOptions:{resolve4:async()=>['8.8.8.8'],resolve6:async()=>[],request:async({headers})=>{requests++;assert.equal(headers.cookie,'session=synthetic-secret');return {status:200,body:Buffer.from(html)}}},executablePath:'/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome'})();
 const start=c.provider.start(); await tick();
 await assert.rejects(c.source.read({url:'https://tieba.baidu.com/p/123',forum:'肥鱼避难所吧'}),/unavailable/); assert.equal(requests,0);
 finish(); assert.deepEqual(await start,{state:'online'});
 const post=await c.source.read({url:'https://tieba.baidu.com/p/123',forum:'肥鱼避难所吧'});
 assert.match(post.body,/虚构帖子/); assert.doesNotMatch(JSON.stringify(post),/synthetic-secret/); assert.equal(requests,1);
 await c.close(); assert.equal(closes,1);
});

test('cancel, disconnect and timeout end waiting without owner completion', async () => {
 for (const mode of ['cancel','disconnect','timeout']) {
   const f=fixture({ttlMs:mode==='timeout'?30:1000}), start=f.c.provider.start(); await tick();
   if(mode==='cancel') await f.c.provider.cancel();
   if(mode==='disconnect') f.disconnected.abort();
   const keepAlive = mode==='timeout' ? setTimeout(()=>{},100) : null;
   assert.deepEqual(await start,{state:'unknown'},mode); clearTimeout(keepAlive); assert.equal(f.closed,1,mode);
   f.complete(); await tick(); assert.deepEqual(await f.c.provider.status(),{state:'unknown'});
   assert.equal(f.reads,0); await f.c.close();
 }
});
