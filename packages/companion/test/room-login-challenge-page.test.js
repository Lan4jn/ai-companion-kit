import test from 'node:test';
import assert from 'node:assert/strict';
import { LOGIN_PAGE } from '../src/room-login-page.js';
test('登录页说明挑战的会话保留、官方处理限制和凭据安全',()=>{
  assert.match(LOGIN_PAGE,/challenge:/);
  assert.match(LOGIN_PAGE,/不能在此页面操作/);
  assert.match(LOGIN_PAGE,/不要.*验证码/);
  assert.match(LOGIN_PAGE,/j\.state===['"]challenge['"]/);
});
