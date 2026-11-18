import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoginService } from '../src/room-login-service.js';

test('B站状态根据平台响应区分登录、失效、风控和网络故障', async () => {
  let result = {code:0,data:{isLogin:true}};
  const svc = createLoginService({ getBiliCredentials: () => ({sessdata:'not-a-real-cookie'}), fetcher: async () => ({ok:true,json:async()=>result}) });
  assert.equal((await svc.checkBili()).state,'online');
  result = {code:-101};
  assert.equal((await svc.checkBili()).state,'offline');
  result = {code:-352};
  assert.equal((await svc.checkBili()).state,'risk');
  const broken = createLoginService({ getBiliCredentials: () => ({sessdata:'not-a-real-cookie'}), fetcher: async () => {throw Error('network');} });
  assert.equal((await broken.checkBili()).state,'unknown');
});
