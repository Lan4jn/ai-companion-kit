import {createCredentialStore} from './douyin-credential-store.js';

function hasUsableSession(cookies) {
  const now=Date.now()/1000;
  return cookies.some(c=>c && c.name==='sessionid' && typeof c.value==='string' && c.value.length>0 &&
    ['.douyin.com','www.douyin.com','.www.douyin.com'].includes(c.domain) &&
    c.path==='/' && (c.expires===-1 || (Number.isFinite(c.expires) && c.expires>now)));
}

// Identity is transient and is never logged or stored. Both proofs must come
// from separate contexts; a generic online result is not sufficient.
export function beginDouyinRenewal({store, enabled, verify}) {
  let snapshot;
  try {
    if (enabled === true) {
      const current=store.snapshot();
      // Detach the versioned baseline from caller/store-owned mutable objects.
      snapshot={version:current.version,cookies:JSON.parse(JSON.stringify(current.cookies))};
    }
  } catch {}
  let used=false;
  return {
    cookies: snapshot?.cookies == null ? snapshot?.cookies : JSON.parse(JSON.stringify(snapshot.cookies)),
    async finish(candidate) {
      if (used) return false;
      used=true;
      try {
        // Freeze the exact candidate being verified before the first await;
        // neither caller nor verifier may change the bytes later committed.
        const proposed=JSON.parse(JSON.stringify(candidate));
        if (!snapshot || !Array.isArray(snapshot.cookies) || !Array.isArray(proposed) || !hasUsableSession(proposed)) return false;
        if (JSON.stringify(snapshot.cookies)===JSON.stringify(proposed)) return false;
        const before=await verify(JSON.parse(JSON.stringify(snapshot.cookies)));
        const after=await verify(JSON.parse(JSON.stringify(proposed)));
        if (before?.state!=='online' || after?.state!=='online' || typeof before.identity!=='string' || !before.identity.trim() || before.identity!==after.identity) return false;
        return store.commit(snapshot.version,proposed);
      } catch {return false;}
    },
  };
}

export function createBrowserRenewal(dataDir,browser,enabled) {
  const store=createCredentialStore(dataDir);
  const verify=async cookies=>{
    let context;
    try {
      context=await browser.newContext({userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'});
      await context.addCookies(cookies);
      const response=await context.request.get('https://www.douyin.com/aweme/v1/web/user/profile/self/?device_platform=webapp&aid=6383&channel=channel_pc_web&pc_client_type=1&version_code=170400&version_name=17.4.0',{headers:{referer:'https://www.douyin.com/'},timeout:25000,maxRedirects:0});
      if (!response.ok()) return {state:'unknown'};
      const body=await response.json();
      const identity=body?.user?.sec_uid;
      return body?.status_code===0 && typeof identity==='string' && identity.trim() ? {state:'online',identity} : {state:'unknown'};
    } catch {return {state:'unknown'};} finally {await context?.close().catch(()=>{});}
  };
  return beginDouyinRenewal({store,enabled,verify});
}
