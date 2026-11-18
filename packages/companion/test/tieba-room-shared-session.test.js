import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { startVirtualRoomServer } from '../src/virtual-room.js';
import { createFixtureCandidate, createFixtureReaderSource } from '../src/tieba-login-candidate-fixture.js';
import { createTiebaReader } from '../src/tieba-reader.js';

test('isolated fixture login page and real reader share the same candidate', async t => {
  const root = await mkdtemp(join(process.env.TMPDIR, 'tieba-room-e2e-'));
  const candidate = await createFixtureCandidate({root});
  let online = false;
  const provider = {
    status: async () => ({state: online ? 'online' : 'unknown'}),
    start: async () => { await candidate.login(); online = true; return {state:'online'}; },
  };
  const room = startVirtualRoomServer({port:0, host:'127.0.0.1', dataDir:root, tiebaLoginProvider:provider});
  let browser;
  t.after(async () => { await browser?.close(); await room.stop(); await candidate.close(); await rm(root,{recursive:true,force:true}); });
  const {port} = await room.ready;
  const source = createFixtureReaderSource(candidate);
  let prompts=0;
  const reader = createTiebaReader({enabled:true,source,dir:root,brain:{complete:async ({prompt})=>{prompts++; assert.match(prompt,/fixture forum content/);return JSON.stringify({action:'continue',record:false,keywords:[]});}}});
  assert.equal((await reader.run()).status,'source_failed');
  browser = await chromium.launch({executablePath:'/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome',headless:true,args:['--no-sandbox']});
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/login`);
  page.once('dialog', dialog => dialog.accept());
  await page.click('#tieba-start');
  await page.waitForFunction(() => document.querySelector('#tieba').textContent.includes('已登录'));
  assert.deepEqual(await reader.run(),{status:'completed',read:1,saved:0});
  assert.equal(prompts,1);
  const rejected = await fetch(`http://127.0.0.1:${port}/api/account/tieba/start`, {method:'POST',headers:{origin:'http://evil.invalid'}});
  assert.equal(rejected.status,403);
});

test('provider failures never leak internal errors or claim authenticated', async t => {
  const room = startVirtualRoomServer({port:0,host:'127.0.0.1',tiebaLoginProvider:{status:async()=>{throw Error('secret-cookie');},start:async()=>({state:'online',cookie:'secret-cookie'})}});
  t.after(()=>room.stop());
  const {port}=await room.ready;
  const base=`http://127.0.0.1:${port}`;
  const status=await fetch(`${base}/api/account/tieba/status`);
  assert.deepEqual(await status.json(),{state:'unknown'});
  const started=await fetch(`${base}/api/account/tieba/start`,{method:'POST',headers:{origin:base}});
  assert.equal(await started.text(),'{"state":"online"}');
});
