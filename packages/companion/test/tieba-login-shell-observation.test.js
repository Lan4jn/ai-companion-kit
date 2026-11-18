import test from 'node:test';
import assert from 'node:assert/strict';
import {isObservedTiebaLoginShellRequest as allowed} from '../src/tieba-login-shell-observation.js';
const q=(url,resourceType='script',extra={})=>({url,method:'GET',resourceType,...extra});
test('only exact observed HTTPS shell paths and types are candidates',()=>{
 assert.equal(allowed(q('https://passport.baidu.com/passApi/js/wrapper.js')),true);
 assert.equal(allowed(q('https://passport.baidu.com/v2/','document')),true);
 assert.equal(allowed(q('https://ppui-static-pc.cdn.bcebos.com/static/passpc-base/css/base.css','stylesheet')),true);
 for(const x of [
  q('https://passport.baidu.com/v2/?login&u=https://tieba.baidu.com/','document'),
  q('https://passport.baidu.com/v2/api/getqrcode','xhr'),q('https://passport.baidu.com/cap/init','xhr',{method:'POST'}),
  q('https://passport.baidu.com/v2/api/?callback=evil'),q('https://passport.baidu.com/viewlog','xhr'),
  q('https://hm.baidu.com/h.js'),q('https://passport.baidu.com.evil.test/passApi/js/wrapper.js'),
  q('http://passport.baidu.com/passApi/js/wrapper.js'),q('https://passport.baidu.com:444/passApi/js/wrapper.js'),
  q('https://x@passport.baidu.com/passApi/js/wrapper.js'),q('https://passport.baidu.com/passApi/js/wrapper.js#x'),
  q('https://passport.baidu.com/passApi/js/wrapper.js','image'),q('https://passport.baidu.com/passApi/js/wrapper.js','script',{redirected:true}),
  q('https://passport.baidu.com/passApi/js/wrapper.js','script',{method:'POST'}),q('https://127.0.0.1/passApi/js/wrapper.js'),
 ]) assert.equal(allowed(x),false,JSON.stringify(x));
});
