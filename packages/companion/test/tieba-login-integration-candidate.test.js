import test from 'node:test';
import assert from 'node:assert/strict';
import { createTiebaLoginIntegration } from '../src/tieba-login-integration.js';
import { createTiebaReader } from '../src/tieba-reader.js';
import { startVirtualRoomServer } from '../src/virtual-room.js';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const url = 'https://tieba.baidu.com/p/123';
const html = '<div class="forum-name-main">肥鱼避难所</div><div class="forum-name-suffix">吧</div><div class="center-content"><div class="image-text"><div class="pb-title">可爱的橘猫</div><div class="pb-content-wrap"><div tid="123">这只橘猫很可爱</div></div><div class="desc-info"><span class="post-num">2026-01-01</span></div></div></div>';
const makeSession = async () => ({context:{cookies:async()=>[{name:'session',value:'syntheticSecretValue',domain:'tieba.baidu.com',secure:true,path:'/'}]}, close:async()=>{}});
const transportOptions = {resolve4:async()=>['8.8.8.8'],resolve6:async()=>[],request:async ({headers})=>{assert.equal(headers.cookie,'session=syntheticSecretValue');return {status:200,body:Buffer.from(html)};}};
const listSource={list:async()=>[{url}]};

test('unknown identity fails closed and never reaches controlled transport', async () => {
 let requests=0, closed=0;
 const c=createTiebaLoginIntegration({createSession:async()=>({...await makeSession(),close:async()=>{closed++}}),verifyIdentity:async()=>({state:'unknown'}),listSource,transportOptions:{...transportOptions,request:async()=>{requests++}}});
 assert.deepEqual(await c.provider.start(),{state:'unknown'});
 assert.deepEqual(await c.provider.status(),{state:'unknown'});
 await assert.rejects(c.source.list({forum:'肥鱼避难所吧'}),/unavailable/);
 assert.equal(requests,0); assert.equal(closed,1); await c.close();
});

test('verified synthetic identity gates same session into controlled reader and close revokes it', async () => {
 const c=createTiebaLoginIntegration({createSession:makeSession,verifyIdentity:async()=>({state:'online'}),listSource,transportOptions,executablePath:'/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome'});
 assert.deepEqual(await c.provider.start(),{state:'online'});
 assert.deepEqual(await c.source.list({forum:'肥鱼避难所吧'}),[{url}]);
 const post=await c.source.read({url,forum:'肥鱼避难所吧'});
 assert.match(post.body,/橘猫/); assert.doesNotMatch(JSON.stringify(post),/syntheticSecretValue/);
 await c.close(); assert.deepEqual(await c.provider.status(),{state:'unknown'});
 await assert.rejects(c.source.read({url,forum:'肥鱼避难所吧'}),/unavailable/);
});


test('local room endpoint, identity gate, transport and real reader share the session', async t => {
 const dir=await mkdtemp(join(process.env.TMPDIR,'tieba-integrated-')); let valid=true, hits=0;
 const c=createTiebaLoginIntegration({createSession:makeSession,verifyIdentity:async()=>({state:valid?'online':'unknown'}),listSource,transportOptions:{...transportOptions,request:async o=>{hits++;return transportOptions.request(o);}},executablePath:'/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome'});
 const room=startVirtualRoomServer({port:0,host:'127.0.0.1',dataDir:dir,tiebaLoginProvider:c.provider});
 t.after(async()=>{await room.stop();await c.close();await rm(dir,{recursive:true,force:true})});
 const {port}=await room.ready, base=`http://127.0.0.1:${port}`;
 const page=await fetch(base+'/login'); assert.match(await page.text(),/tieba-start/);
 const reader=createTiebaReader({enabled:true,source:c.source,dir,brain:{complete:async ({prompt})=>{assert.doesNotMatch(prompt,/syntheticSecretValue/);return JSON.stringify({action:'continue',record:false,keywords:[]});}}});
 assert.equal((await reader.run()).status,'source_failed');
 const start=await fetch(base+'/api/account/tieba/start',{method:'POST',headers:{origin:base}});assert.deepEqual(await start.json(),{state:'online'});
 assert.deepEqual(await reader.run(),{status:'completed',read:1,saved:0}); assert.equal(hits,1);
 valid=false; assert.deepEqual(await (await fetch(base+'/api/account/tieba/status')).json(),{state:'unknown'});
 assert.equal((await reader.run()).status,'source_failed'); assert.equal(hits,1);
 assert.deepEqual(await readdir(dir),[]);
});
