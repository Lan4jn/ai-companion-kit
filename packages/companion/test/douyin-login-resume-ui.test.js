import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {LOGIN_PAGE} from '../src/room-login-page.js';

test('login page bounds requests and prevents overlapping status checks',()=>{
 assert.match(LOGIN_PAGE,/AbortSignal\.timeout\(\d+\)/);
 assert.match(LOGIN_PAGE,/statusPending/);
});

test('reopening an existing challenged session keeps polling without exposing QR',async()=>{
 const elements={}; for(const id of ['bili','douyin','bili-start','douyin-start','bili-qr','douyin-qr']) elements[id]={hidden:true,removeAttribute(){},textContent:'',disabled:false};
 let polls=0; const fetch=async url=>({ok:true,json:async()=> url.endsWith('/start') ? {state:'challenge'} : url.endsWith('/poll') ? (polls++,{state:'challenge'}) : {state:'offline'}});
 const ctx=vm.createContext({document:{getElementById:id=>elements[id]},fetch,confirm:()=>true,setTimeout:()=>{},setInterval:()=>{},AbortSignal});
 vm.runInContext(LOGIN_PAGE.match(/<script>([\s\S]*)<\/script>/)[1],ctx);
 await vm.runInContext("start('douyin')",ctx); await new Promise(resolve=>setImmediate(resolve));
 assert.equal(polls,1); assert.equal(elements['douyin-start'].disabled,true); assert.equal(elements['douyin-qr'].hidden,true);
});
