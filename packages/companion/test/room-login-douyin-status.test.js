import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createLoginService } from '../src/room-login-service.js';
import { LOGIN_PAGE } from '../src/room-login-page.js';

const cookies=[{name:'sessionid',value:'test'}];
function browserFor({status=200, body={}, fail=false}) {
  return {launch:async()=>({newContext:async()=>({addCookies:async()=>{},request:{get:async()=>{if(fail)throw Error('network'); return {status:()=>status,ok:()=>status>=200&&status<300,json:async()=>body};}}}),close:async()=>{}})};
}
test('抖音独立个人资料接口区分在线、失效、风控和不可判断',async()=>{
  for (const [scenario,state] of [
    [{body:{status_code:0,user:{uid:'123'}}},'online'],
    [{body:{status_code:8,status_msg:'用户未登录'}},'offline'],
    [{status:429},'risk'],
    [{body:{status_code:8,status_msg:'其他错误'}},'unknown'],
    [{body:{status_code:0,user:null}},'unknown'],
    [{fail:true},'unknown'],
  ]) {
    const svc=createLoginService({browserLauncher:browserFor(scenario)});
    assert.equal((await svc.checkDouyin(cookies)).state,state);
  }
});
test('未知终态隐藏二维码并停止轮询',async()=>{
  const elements=Object.fromEntries(['bili','douyin','bili-qr','douyin-qr','bili-start','douyin-start'].map(x=>[x,{hidden:false,textContent:'',src:'',removeAttribute(name){delete this[name]}}]));
  let pending=0;
  const script=LOGIN_PAGE.match(/<script>([\s\S]*?)<\/script>/)[1];
  const sandbox={document:{getElementById:id=>elements[id]}, fetch:async url=>({ok:true,json:async()=>({state:url.endsWith('/poll')?'unknown':url.endsWith('/start')?'waiting':'offline'})}),confirm:()=>true,setTimeout:()=>{pending++},setInterval:()=>{}};
  vm.createContext(sandbox);vm.runInContext(script,sandbox);
  await vm.runInContext("start('douyin')",sandbox);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(elements['douyin-qr'].hidden,true);
  assert.equal(pending,0);
});
