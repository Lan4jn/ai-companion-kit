import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createTiebaReadOnlyCandidate, createTiebaCandidateSource } from '../src/tieba-trusted-session-bridge.js';
import { createTiebaReader } from '../src/tieba-reader.js';

const url = 'https://tieba.baidu.com/p/123';
const html = '<div class="forum-name-main">肥鱼避难所</div><div class="forum-name-suffix">吧</div><div class="center-content"><div class="image-text"><div class="pb-title">可爱的橘猫</div><div class="pb-content-wrap"><div tid="123">这只橘猫很可爱</div></div><div class="desc-info"><span class="post-num">2026-01-01</span></div></div></div>';
const chrome = '/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome';

test('isolated session body reaches the actual reader without exposing credentials', async () => {
  const dir = await mkdtemp(join(process.env.TMPDIR, 'tieba-controlled-'));
  let prompt = '';
  const transport = createTiebaReadOnlyCandidate({ context: { cookies: async () => [{ name: 'session', value: 'syntheticSecretValue', domain: 'tieba.baidu.com', secure: true, path: '/' }] }, resolve4: async () => ['8.8.8.8'], resolve6: async () => [], request: async ({headers}) => { assert.equal(headers.cookie, 'session=syntheticSecretValue'); return { status: 200, body: Buffer.from(html) }; } });
  const source = createTiebaCandidateSource({ transport, listSource: { list: async () => [{url}] }, executablePath: chrome });
  const reader = createTiebaReader({ enabled: true, dir, source, brain: { complete: async ({prompt: p}) => { prompt = p; return JSON.stringify({action:'continue',record:false,keywords:[]}); } } });
  try { assert.deepEqual(await reader.run(), { status: 'completed', read: 1, saved: 0 }); assert.match(prompt, /这只橘猫很可爱/); assert.doesNotMatch(prompt, /syntheticSecretValue|session=/); }
  finally { await source.close(); await rm(dir, {recursive:true,force:true}); }
});

test('expired credentials are not sent, errors are closed, and close destroys the source', async () => {
  let calls = 0;
  const transport = createTiebaReadOnlyCandidate({ context: { cookies: async () => [{ name:'expired', value:'syntheticExpiredSecret', domain:'tieba.baidu.com', secure:true, path:'/', expires:1 }] }, resolve4: async () => ['8.8.8.8'], resolve6: async () => [], request: async ({headers}) => { calls++; assert.equal(headers.cookie, undefined); return {status:401, body:Buffer.from('login')}; } });
  const source = createTiebaCandidateSource({ transport, listSource: { list: async () => [{url}] }, executablePath: chrome });
  await assert.rejects(source.read({url, forum:'肥鱼避难所吧'}), /response_blocked/);
  await source.close(); await source.close();
  await assert.rejects(source.read({url, forum:'肥鱼避难所吧'}), /closed/);
  assert.equal(calls, 1);
});

test('wrong forum, wrong thread and login pages fail closed before the model', async () => {
  for (const body of [html.replace('肥鱼避难所', '其他'), html.replace('tid="123"', 'tid="999"'), '<html>请登录</html>']) {
    const transport = createTiebaReadOnlyCandidate({ context: {cookies:async()=>[]}, resolve4:async()=>['8.8.8.8'], resolve6:async()=>[], request:async()=>({status:200,body:Buffer.from(body)}) });
    const source = createTiebaCandidateSource({transport, listSource:{list:async()=>[{url}]}, executablePath:chrome});
    try { await assert.rejects(source.read({url,forum:'肥鱼避难所吧'}), /incomplete_thread/); } finally { await source.close(); }
  }
});

test('response reflecting credential bytes is rejected instead of reaching reader', async () => {
  const transport = createTiebaReadOnlyCandidate({ context: { cookies: async () => [{name:'session',value:'syntheticSecretValue',domain:'tieba.baidu.com',secure:true,path:'/'}] }, resolve4: async () => ['8.8.8.8'], resolve6: async () => [], request: async () => ({status:200,body:Buffer.from(html + ' syntheticSecretValue')}) });
  try { await assert.rejects(transport.fetchBody(url), /response_blocked/); } finally { await transport.close(); }
});
