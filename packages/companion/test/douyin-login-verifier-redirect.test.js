import test from 'node:test';
import assert from 'node:assert/strict';
import {createLoginService} from '../src/room-login-service.js';

test('抖音登录验证不得跟随重定向并将目标站点响应当成登录证明', async () => {
  let options;
  const browserLauncher={launch:async()=>({newContext:async()=>({addCookies:async()=>{},request:{get:async(_url,opts)=>{
    options=opts;
    // A redirect to another page would otherwise produce a misleading 200.
    return opts.maxRedirects === 0
      ? {status:()=>302,ok:()=>false}
      : {status:()=>200,ok:()=>true,json:async()=>({status_code:0,user:{uid:'synthetic'}})};
  }}}),close:async()=>{}})};
  const service=createLoginService({browserLauncher});
  assert.equal((await service.checkDouyin([{name:'sessionid',value:'synthetic'}])).state,'unknown');
  assert.equal(options.maxRedirects,0);
});
