// Observed public login-shell resources only; NOT a complete authentication policy.
// This classifier is not an egress firewall and must not enable real login.
const paths = new Map([
  ['passport.baidu.com', new Map([
    ['/v2/', ['document']], ['/passApi/js/uni_wrapper.js', ['script']],
    ['/passApi/js/wrapper.js', ['script']], ['/static/passpc-base/js/ld.min.js', ['script']],
    ['/static/passpc-base/js/dv/g.min.js', ['script']], ['/static/phoenix/scripts/jssdk/all.js', ['script']],
    ['/v3/api/conf/getupsms', ['script']], ['/v2/getpublickey', ['script']],
    ['/v2/api/', ['script']], ['/phoenix/account/jsapi', ['script']], ['/phoenix/account/osavailable', ['script']],
  ])],
  ['wappass.baidu.com', new Map([
    ['/static/waplib/moonshad.js', ['script']], ['/static/machine/js/api/mkd.js', ['script']],
    ['/static/sdk-machine/js/mkd_v2.js', ['script']], ['/static/touch/js/lib/fingerprint.js', ['script']],
    ['/static/machine/css/api/mkd.css', ['stylesheet']],
  ])],
  ['hercules.cdn.bcebos.com', new Map([['/pass/bundle.js', ['script']]])],
  ['ppui-static-pc.cdn.bcebos.com', new Map([
    ['/static/passpc-base/css/base.css',['stylesheet']], ['/static/passpc-base/css/ui/ui.css',['stylesheet']],
    ['/static/passpc-account/css/boot_login_7f3c94c.css',['stylesheet']], ['/static/passpc-base/img/logo/logo.gif',['image']],
    ['/static/passpc-base/js/core.js',['script']], ['/static/passpc-base/js/ui/ui.js',['script']],
    ['/static/passpc-account/js/boot_login_1e30d1a.js',['script']], ['/passApi/js/loginv4_tangram_ac411d1.js',['script']],
    ['/static/passpc-account/img/login/logo_pass.png',['image']], ['/passApi/css/login_common_7a336df.css',['stylesheet']],
    ['/static/passpc-account/img/login/login-bg.png',['image']], ['/passApi/img/loginlogo.gif',['image']],
    ['/passApi/img/loginv4.png',['image']], ['/passApi/img/small_blank.gif',['image']], ['/passApi/img/loading.gif',['image']],
  ])],
]);

export function isObservedTiebaLoginShellRequest({url, method, resourceType, redirected = false} = {}) {
  if (method !== 'GET' || redirected !== false || typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash) return false;
    // Query-bearing JSONP/document endpoints need an independent parameter policy.
    // Deny them rather than treating arbitrary callbacks/redirects as safe.
    if (u.search) return false;
    return paths.get(u.hostname)?.get(u.pathname)?.includes(resourceType) === true;
  } catch { return false; }
}
