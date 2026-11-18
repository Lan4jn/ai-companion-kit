import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync, fork } from 'node:child_process';
import { chromium } from 'playwright-core';
import { randomBytes } from 'node:crypto';
import { createCredentialStore } from './douyin-credential-store.js';
import { safeQrDiagnostic } from './douyin-qr-state.js';

function makeQr(url) {
  return new Promise((resolve, reject) => {
    const child = spawn('qrencode',['-t','PNG','-o','-'],{stdio:['pipe','pipe','ignore']});
    const chunks=[]; let size=0;
    const timer=setTimeout(()=>child.kill(),5000);
    child.on('error',()=>{clearTimeout(timer);reject(new Error('QR generation failed'));});
    child.stdout.on('data',chunk=>{size+=chunk.length;if(size>1024*1024) child.kill(); else chunks.push(chunk);});
    child.on('close',code=>{clearTimeout(timer);code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error('QR generation failed'));});
    child.stdin.on('error',()=>{});
    child.stdin.end(url);
  });
}
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';
const ROOT = path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), '..');

// Metadata lives in the service-owned parent, never in the worker directory.
// Old worker-controlled markers are deliberately not trusted or recovered.
function writeHeadedOwner(root, dir, info, identity) {
  const fd=fs.openSync(root,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
  let tmp;
  try {
    const st=fs.fstatSync(fd);
    if (!identity || st.dev!==identity.dev || st.ino!==identity.ino || st.uid!==process.getuid?.() || (st.mode & 0o077)) throw Error('untrusted session root');
    const pinned=`/proc/self/fd/${fd}`;
    const marker=path.join(pinned,`${path.basename(dir)}.owner.json`);
    tmp=path.join(pinned,`.owner-${randomBytes(16).toString('hex')}`);
    fs.writeFileSync(tmp,JSON.stringify(info),{mode:0o600,flag:'wx'});fs.renameSync(tmp,marker);
  } finally {if(tmp) try {fs.unlinkSync(tmp);} catch {} fs.closeSync(fd);}
}

// fd-relative, symlink-resistant recursive removal; fail closed if unavailable.
function removeHeadedDirectory(root, dir, identity, rootIdentity) {
  const fd=fs.openSync(root,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
  try {
    const st=fs.fstatSync(fd);
    if (!rootIdentity || st.dev!==rootIdentity.dev || st.ino!==rootIdentity.ino || st.uid!==process.getuid?.() || (st.mode & 0o077)) return false;
    const script=`import os,sys,shutil\nfd=3\nn=sys.argv[1]\ns=os.stat(n,dir_fd=fd,follow_symlinks=False)\nif (s.st_dev,s.st_ino)!=(int(sys.argv[2]),int(sys.argv[3])) or not shutil.rmtree.avoids_symlink_attacks: sys.exit(2)\nshutil.rmtree(n,dir_fd=fd)\n`;
    const result=spawnSync('python3',['-c',script,path.basename(dir),String(identity.dev),String(identity.ino)],{stdio:['ignore','ignore','ignore',fd],timeout:30000});
    return result.status===0;
  } finally {fs.closeSync(fd);}
}

// Fail closed for unmarked, inaccessible or possibly live sessions.
function recoverHeadedSessions(root) {
  try {
    fs.mkdirSync(root,{mode:0o700});
  } catch(e) {if(e.code !== 'EEXIST') return;}
  try {
    const st=fs.lstatSync(root);
    if (!st.isDirectory() || st.isSymbolicLink() || fs.realpathSync(root) !== path.resolve(root) || st.uid !== process.getuid?.() || (st.mode & 0o077)) return;
    for (const ent of fs.readdirSync(root,{withFileTypes:true})) {
      if (!ent.name.startsWith('session-') || !ent.isDirectory() || ent.isSymbolicLink()) continue;
      const dir=path.join(root,ent.name), marker=path.join(root,`${ent.name}.owner.json`);
      try {
        const fd=fs.openSync(marker,fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        let info; try {if (!fs.fstatSync(fd).isFile()) continue; info=JSON.parse(fs.readFileSync(fd,'utf8'));} finally {fs.closeSync(fd);}
        if (info.launching || info.verifierLaunching) continue;
        if (![info.owner,info.child].every(n=>Number.isSafeInteger(n) && n>1)) continue;
        const pids=[info.owner,info.child,...(info.verifier ? [info.verifier] : [])];
        if (pids.some(pid=>{if(!Number.isSafeInteger(pid)||pid<=1)return true;try {process.kill(pid,0);return true;} catch(e){return e.code !== 'ESRCH';}})) continue;
        if ([info.child,info.verifier].filter(Boolean).some(pid=>{try {process.kill(-pid,0);return true;} catch(e){return e.code !== 'ESRCH';}})) continue;
        if (info.identity && removeHeadedDirectory(root,dir,info.identity,st)) fs.unlinkSync(marker);
      } catch {} // Unknown ownership or malformed marker: retain.
    }
  } catch {}
}


export function createLoginService({ dataDir = path.join(ROOT, 'data'), getBiliCredentials = () => null, setBiliCredentials = () => {}, fetcher = fetch, spawnLogin = spawn, verifyDouyin = null, makeQrImage = makeQr, browserLauncher = chromium, headedDouyin = false, forkHeaded = fork, forkVerifier = fork, headedSessionRoot = path.join(os.tmpdir(),`douyin-headed-sessions-${process.getuid?.() ?? 'user'}`), headedDaemonPath = path.join(ROOT,'src/douyin-headed-daemon.js'), headedTtlMs = 1800000, headedKillMs = 5000, headedVerifyMs = 30000 } = {}) {
  const credentialStore=createCredentialStore(dataDir);
  recoverHeadedSessions(headedSessionRoot);
  let biliSession = null, dySession = null, headedSession = null, biliGeneration = 0;
  // In-memory only, bounded and enum-only; no credentials, page contents or URLs.
  const dyDiagnostics=[];
  function noteDy(stage) {dyDiagnostics.push({stage:safeQrDiagnostic(stage),at:Date.now()}); if(dyDiagnostics.length>128)dyDiagnostics.shift();}
  function douyinDiagnostics() {return dyDiagnostics.map(event=>({...event}));}
  const request = (url, opts = {}) => fetcher(url, { ...opts, signal: AbortSignal.timeout(12000), headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', ...opts.headers } });
  async function checkBili(cred = getBiliCredentials()) {
    if (!cred?.sessdata) return {state:'offline'};
    try {
      const r = await request('https://api.bilibili.com/x/web-interface/nav', {headers:{cookie:`SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct || ''}`}});
      if (r.status === 412 || r.status === 429 || r.status === 403) return {state:'risk'};
      if (!r.ok) return {state:'unknown'};
      const j = await r.json();
      if (j.code === 0 && j.data?.isLogin === true) return {state:'online'};
      if (j.code === -101 || (j.code === 0 && j.data?.isLogin === false)) return {state:'offline'};
      if ([-352,-403,-412].includes(j.code)) return {state:'risk'};
      return {state:'unknown'};
    } catch { return {state:'unknown'}; }
  }
  async function startBili() {
    biliSession = null;
    const generation=++biliGeneration;
    const r = await request('https://passport.bilibili.com/x/passport-login/web/qrcode/generate');
    if (!r.ok) return {state:'unknown'};
    const j = await r.json();
    const url = j?.data?.url, key = j?.data?.qrcode_key;
    if (j.code !== 0 || !key || !url || !/^https:\/\/(?:[a-z0-9-]+\.)*bilibili\.com\//i.test(url)) return {state:'unknown'};
    const png = await makeQrImage(url);
    if (generation !== biliGeneration) return {state:'expired'};
    biliSession = {key, png, started:Date.now()};
    const current = biliSession;
    const timer=setTimeout(()=>{if (biliSession === current) biliSession=null;},180000);
    timer.unref();
    return {state:'waiting'};
  }
  async function pollBili() {
    const session = biliSession;
    if (!session || Date.now()-session.started > 180000) { biliSession=null; return {state:'expired'}; }
    const finish = state => {if (biliSession === session) biliSession=null; return {state};};
    try {
      const r = await request('https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key='+encodeURIComponent(session.key));
      if (r.status === 412 || r.status === 429 || r.status === 403) return finish('risk');
      if (!r.ok) return finish('unknown');
      const j = await r.json();
      if ([-352,-403,-412].includes(j.code)) return finish('risk');
      if (j.code !== 0) return finish('unknown');
      const code = j.data?.code;
      if (code === 86101) return {state:'waiting'};
      if (code === 86090) return {state:'confirm'};
      if (code === 86038) {return finish('expired');}
      if (code !== 0) return finish('unknown');
      const lines = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
      const cookies = {};
      for (const line of lines) { const m = /^([^=;\s]+)=([^;]*)/.exec(line); if (m) cookies[m[1]]=m[2]; }
      const cred = {sessdata:cookies.SESSDATA, bili_jct:cookies.bili_jct, buvid3:cookies.buvid3 || '', dedeuserid:cookies.DedeUserID || ''};
      if (!cred.sessdata || !cred.bili_jct) return finish('unknown');
      const verified = await checkBili(cred);
      if (biliSession !== session) return {state:'expired'};
      if (verified.state !== 'online') return finish(verified.state);
      fs.mkdirSync(dataDir,{recursive:true,mode:0o700});
      const target=path.join(dataDir,'bili-login-credentials.json');
      const tmp=target+'.'+randomBytes(12).toString('hex')+'.tmp';
      try {
        fs.writeFileSync(tmp,JSON.stringify(cred),{mode:0o600,flag:'wx'});
        fs.renameSync(tmp,target);
      } finally {try {fs.unlinkSync(tmp);} catch {}}
      setBiliCredentials(cred);
      biliSession=null;
      return {state:'online'};
    } catch { return finish('unknown'); }
  }
  async function checkDouyin(cookies) {
    if (cookies === undefined) {
      try { cookies=JSON.parse(fs.readFileSync(path.join(dataDir,'douyin-cookies.json'),'utf8')); } catch (e) {return {state:e.code === 'ENOENT' ? 'offline' : 'unknown'};}
    }
    if (!Array.isArray(cookies) || !cookies.some(c=>c.name==='sessionid' && c.value)) return {state:'offline'};
    let browser;
    try {
      browser=await browserLauncher.launch({executablePath:process.env.CHROME_PATH || '/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
      const context=await browser.newContext({userAgent:UA});
      await context.addCookies(cookies);
      // A server-validated self profile is independent of both the QR daemon
      // and the frequently changing home-page DOM. Never expose its contents.
      const response=await context.request.get('https://www.douyin.com/aweme/v1/web/user/profile/self/?device_platform=webapp&aid=6383&channel=channel_pc_web&pc_client_type=1&version_code=170400&version_name=17.4.0',{headers:{referer:'https://www.douyin.com/'},timeout:25000,maxRedirects:0});
      if ([403,412,429].includes(response.status())) return {state:'risk'};
      if (!response.ok()) return {state:'unknown'};
      const body=await response.json();
      if (body?.status_code === 0 && body.user && (body.user.uid || body.user.sec_uid)) return {state:'online'};
      if (typeof body?.status_msg === 'string' && /安全验证|访问过于频繁|操作频繁|风控/.test(body.status_msg)) return {state:'risk'};
      if (typeof body?.status_msg === 'string' && /用户未登录|请先登录/.test(body.status_msg)) return {state:'offline'};
      return {state:'unknown'};
    } catch {return {state:'unknown'};} finally {await browser?.close().catch(()=>{});}
  }
  function finishDouyin(session, state) {
    if (session.done) return session.done;
    session.done = {state};
    noteDy(({online:'promoted',offline:'verify_offline',risk:'verify_risk',unknown:'unknown',expired:'expired'})[state] || 'unknown');
    clearTimeout(session.timer);
    if (session.child.exitCode === null) session.child.kill();
    fs.rmSync(session.dir, {recursive:true, force:true});
    return session.done;
  }
  function startDouyin() {
    if (headedSession && !headedSession.cleaned) return {state:'busy'};
    if (dySession && !dySession.done) {
      try { const status=JSON.parse(fs.readFileSync(path.join(dySession.dir,'status.json'),'utf8')).status; if (status === 'need_sms' || status === 'risk') return {state:'challenge'}; } catch {}
      return {state:'waiting'};
    }
    let version;
    try {version=credentialStore.snapshot().version;} catch {return {state:'unknown'};}
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-login-'));
    fs.chmodSync(dir, 0o700);
    let child;
    try {
      child=spawnLogin(process.execPath,[path.join(ROOT,'src/douyin-qr-daemon.js')],{stdio:'ignore',env:{...process.env,DOUYIN_LOGIN_SESSION_DIR:dir}});
    } catch {
      fs.rmSync(dir,{recursive:true,force:true});
      return {state:'unknown'};
    }
    const session = {dir,child,version,done:null, pending:null};
    dyDiagnostics.length=0; noteDy('starting');
    dySession=session;
    session.timer=setTimeout(()=>finishDouyin(session,'expired'),1800000);
    session.timer.unref();
    child.on('error',()=>finishDouyin(session,'unknown'));
    child.on('exit',()=>{
      if (session.done || session.pending) return;
      try {
        const status=JSON.parse(fs.readFileSync(path.join(dir,'status.json'),'utf8')).status;
        if (status === 'success') return; // poll verifies the isolated candidate
        finishDouyin(session,status === 'need_sms' ? 'risk' : status === 'expired' ? 'expired' : 'unknown');
      } catch { finishDouyin(session,'unknown'); }
    });
    return {state:'waiting'};
  }
  async function douyinProgress() {
    const session=dySession;
    if (!session) return {state:'expired'};
    if (session.done) return session.done;
    if (session.pending) return session.pending;
    let status;
    try {status=JSON.parse(fs.readFileSync(path.join(session.dir,'status.json'),'utf8')).status;}
    catch {return session.child.exitCode === null ? {state:'waiting'} : finishDouyin(session,'unknown');}
    const stage=({need_sms:'challenge',risk:'challenge',success:'candidate',error:'browser_error'})[status] || safeQrDiagnostic(status);
    if (session.lastStage !== stage) {session.lastStage=stage;noteDy(stage);}
    if (status === 'need_sms' || status === 'risk') {
      if (session.child.exitCode !== null) return finishDouyin(session,'risk');
      try { fs.unlinkSync(path.join(session.dir,'qr.png')); } catch {}
      session.challenge = true;
      return {state:'challenge'};
    }
    session.challenge = false;
    if (status === 'confirm') return session.child.exitCode === null && session.child.signalCode == null ? {state:'confirm'} : finishDouyin(session,'unknown');
    if (status === 'error' || status === 'unknown') return finishDouyin(session,'unknown');
    if (status === 'expired') return finishDouyin(session,'expired');
    if (status !== 'success') return session.child.exitCode === null ? {state:'waiting'} : finishDouyin(session,'unknown');
    // Stop QR exposure before checking the candidate in an independent context.
    try {fs.unlinkSync(path.join(session.dir,'qr.png'));} catch {}
    session.pending=(async()=>{
      try {
        const cookies=JSON.parse(fs.readFileSync(path.join(session.dir,'cookies.json'),'utf8'));
        if (!Array.isArray(cookies) || !cookies.some(c=>c.name==='sessionid' && c.value)) return finishDouyin(session,'unknown');
        noteDy('verifying');
        const result=await (verifyDouyin || checkDouyin)(cookies);
        if (session.done) return session.done;
        if (result?.state !== 'online') {noteDy(result?.state === 'risk' ? 'verify_risk' : result?.state === 'offline' ? 'verify_offline' : 'verify_unknown');return finishDouyin(session,['risk','offline'].includes(result?.state) ? result.state : 'unknown');}
        noteDy('verified');
        if (!credentialStore.commit(session.version,cookies)) {noteDy('commit_failed');return finishDouyin(session,'unknown');}
        return finishDouyin(session,'online');
      } catch {return finishDouyin(session,'unknown');}
    })();
    return session.pending;
  }
  function cancelDouyin() {
    return dySession ? finishDouyin(dySession, 'expired') : {state:'expired'};
  }
  // In-process only: callers must not publish this capability over a network.
  function startHeadedDouyin() {
    if (!headedDouyin) return {state:'disabled'};
    if (headedSession && !headedSession.cleaned) return {state:'busy'};
    if (dySession && (!dySession.done || (dySession.child.exitCode === null && dySession.child.signalCode == null))) return {state:'busy'};
    let dir, rootIdentity, dirIdentity, version;
    try {
      version=credentialStore.snapshot().version;
      const st=fs.lstatSync(headedSessionRoot);
      if (!st.isDirectory() || st.isSymbolicLink() || fs.realpathSync(headedSessionRoot)!==path.resolve(headedSessionRoot) || st.uid!==process.getuid?.() || (st.mode & 0o077)) return {state:'unknown'};
      rootIdentity={dev:st.dev,ino:st.ino};
      dir=fs.mkdtempSync(path.join(headedSessionRoot,'session-'));
      fs.chmodSync(dir,0o700);
      const ds=fs.lstatSync(dir); dirIdentity={dev:ds.dev,ino:ds.ino};
      writeHeadedOwner(headedSessionRoot,dir,{owner:process.pid,launching:true,identity:dirIdentity},rootIdentity);
    } catch {return {state:'unknown'};}
    let child;
    try {
      child=forkHeaded(headedDaemonPath,[],{stdio:['ignore','ignore','ignore','ipc'],detached:true,env:{...process.env,DOUYIN_LOGIN_SESSION_DIR:dir}});
    } catch {
      try {if (removeHeadedDirectory(headedSessionRoot,dir,dirIdentity,rootIdentity)) fs.unlinkSync(path.join(headedSessionRoot,`${path.basename(dir)}.owner.json`));} catch {}
      return {state:'unknown'};
    }
    const session={dir,rootIdentity,dirIdentity,version,child,state:'starting',display:null,cleaned:false,exited:false,stopping:null,pending:null};
    if (child.pid) {
      try {writeHeadedOwner(headedSessionRoot,dir,{owner:process.pid,child:child.pid,identity:dirIdentity},rootIdentity);}
      catch {try {child.kill('SIGKILL');} catch {}}
    }
    headedSession=session;
    session.exitedPromise=new Promise(resolve=>{session.resolveExit=resolve;});
    child.on('message',message=>{
      if (headedSession !== session || session.stopping || session.exited || session.display) return;
      if (message?.type !== 'display' || typeof message.socket !== 'string' || !path.isAbsolute(message.socket) || !message.socket.startsWith(dir+path.sep) || !/^[a-f0-9]{64}$/.test(message.token || '')) {
        void stopHeaded(session,'unknown'); return;
      }
      session.display={socket:message.socket,token:message.token};
      session.state='waiting';
    });
    child.once('error',()=>{
      if (!child.pid) {session.exited=true; session.resolveExit();}
      void stopHeaded(session,'unknown');
    });
    child.once('exit',(code,signal)=>{
      session.exited=true; session.resolveExit();
      if (session.stopping) return;
      if (signal || code !== 0) {void stopHeaded(session,'unknown'); return;}
      let status;
      try { status=JSON.parse(fs.readFileSync(path.join(dir,'status.json'),'utf8')).status; } catch {}
      if (status === 'success') {session.display=null; session.state='candidate';}
      else void stopHeaded(session,status === 'expired' ? 'expired' : 'unknown');
    });
    session.timer=setTimeout(()=>{void disconnectHeadedDouyin();},headedTtlMs);
    session.timer.unref();
    return {state:'starting'};
  }
  function stopHeaded(session,state='expired') {
    if (session.stopping) return session.stopping;
    session.state=state; session.display=null;
    session.abortVerification?.();
    clearTimeout(session.timer);
    session.stopping=(async()=>{
      if (session.verificationDone) await session.verificationDone;
      if (!session.exited) {
        try {session.child.kill('SIGTERM');} catch {}
        const kill=setTimeout(()=>{try {if (session.child.pid) process.kill(-session.child.pid,'SIGKILL'); else session.child.kill('SIGKILL');} catch {}},headedKillMs);
        await session.exitedPromise;
        clearTimeout(kill);
      }
      // Only remove the exact directory allocated for this session. The parent
      // must remain owner-controlled and no path component may be a symlink.
      try {
        const root=fs.lstatSync(headedSessionRoot), dir=fs.lstatSync(session.dir);
        if (root.isDirectory() && !root.isSymbolicLink() && root.uid===process.getuid?.() && !(root.mode & 0o022) &&
            root.dev===session.rootIdentity.dev && root.ino===session.rootIdentity.ino &&
            fs.realpathSync(headedSessionRoot)===path.resolve(headedSessionRoot) &&
            dir.isDirectory() && !dir.isSymbolicLink() && dir.dev===session.dirIdentity.dev && dir.ino===session.dirIdentity.ino) {
          if (removeHeadedDirectory(headedSessionRoot,session.dir,session.dirIdentity,session.rootIdentity)) {
            try {fs.unlinkSync(path.join(headedSessionRoot,`${path.basename(session.dir)}.owner.json`));} catch {}
          }
        }
      } catch {} // Retain anything whose identity cannot be established.
      session.cleaned=true;
      return {state};
    })();
    return session.stopping;
  }
  function headedDouyinDisplay() {
    return headedSession && !headedSession.stopping && headedSession.display ? {...headedSession.display} : null;
  }
  function verifyHeaded(session,cookies) {
    if (verifyDouyin) {
      const controller=new AbortController();
      session.abortVerification=()=>controller.abort();
      return Promise.race([
        Promise.resolve().then(()=>verifyDouyin(cookies,{signal:controller.signal})),
        new Promise(resolve=>{controller.signal.addEventListener('abort',()=>resolve({state:'expired'}),{once:true});})
      ]);
    }
    return new Promise(resolve=>{
      let child, result={state:'unknown'}, finished=false;
      try {writeHeadedOwner(headedSessionRoot,session.dir,{owner:process.pid,child:session.child.pid,verifierLaunching:true,identity:session.dirIdentity},session.rootIdentity);}
      catch {resolve(result);return;}
      try {child=forkVerifier(path.join(ROOT,'src/douyin-login-verifier.js'),[],{stdio:['ignore','ignore','ignore','ipc'],detached:true});}
      catch {resolve(result);return;}
      try {if(child.pid) writeHeadedOwner(headedSessionRoot,session.dir,{owner:process.pid,child:session.child.pid,verifier:child.pid,identity:session.dirIdentity},session.rootIdentity);}
      catch {try {child.kill('SIGKILL');} catch {}}
      const kill=()=>{ if (child.pid) {try {process.kill(-child.pid,'SIGKILL');} catch {try {child.kill('SIGKILL');} catch {}}} };
      session.abortVerification=()=>{result={state:'expired'};kill();};
      const timer=setTimeout(session.abortVerification,headedVerifyMs);
      child.on('message',m=>{result=m; kill();});
      child.on('error',()=>{kill(); if (!child.pid) finish();});
      child.on('exit',finish);
      function finish(){if(finished)return;finished=true; clearTimeout(timer);kill();session.abortVerification=null;resolve(result);}
      try {child.send({cookies},err=>{if(err)kill();});} catch {kill();}
    });
  }
  async function headedDouyinProgress() {
    const s=headedSession;
    if (!s) return {state:'expired'};
    if (s.stopping) return s.stopping;
    if (s.pending) return s.pending;
    // Publication is synchronous: once success is visible a disconnect may
    // no longer discard the candidate merely because the child has not exited.
    if (s.state !== 'candidate') {
      try {
        if (JSON.parse(fs.readFileSync(path.join(s.dir,'status.json'),'utf8')).status === 'success') {
          s.state='candidate'; s.display=null;
        }
      } catch {}
    }
    if (s.state !== 'candidate') return {state:s.state};
    s.pending=(async()=>{
      try {
        const cookies=JSON.parse(fs.readFileSync(path.join(s.dir,'cookies.json'),'utf8'));
        if (!Array.isArray(cookies) || !cookies.some(c=>c.name==='sessionid' && c.value)) return stopHeaded(s,'unknown');
        let verificationTimer;
        const verificationTimeout=new Promise(resolve=>{verificationTimer=setTimeout(()=>resolve({state:'expired'}),headedVerifyMs);});
        let result;
        const verification=s.verificationDone=verifyHeaded(s,cookies);
        try {result=await Promise.race([verification,verificationTimeout]);}
        finally {clearTimeout(verificationTimer); if (result?.state === 'expired') {s.abortVerification?.(); if (s.verificationDone) await s.verificationDone;}}
        if (s.stopping) return s.stopping;
        if (result?.state === 'expired') return stopHeaded(s,'expired');
        if (result?.state !== 'online') return stopHeaded(s,['risk','offline'].includes(result?.state) ? result.state : 'unknown');
        if (!credentialStore.commit(s.version,cookies)) return stopHeaded(s,'unknown');
        return stopHeaded(s,'online');
      } catch {return stopHeaded(s,'unknown');}
    })();
    return s.pending;
  }
  function cancelHeadedDouyin() {return headedSession ? stopHeaded(headedSession) : Promise.resolve({state:'expired'});}
  async function disconnectHeadedDouyin() {
    const s=headedSession;
    if (!s) return {state:'expired'};
    if (s.stopping) return s.stopping;
    if (s.pending || s.state === 'candidate') return headedDouyinProgress();
    try {
      if (JSON.parse(fs.readFileSync(path.join(s.dir,'status.json'),'utf8')).status === 'success') return headedDouyinProgress();
    } catch {}
    return stopHeaded(s,'expired');
  }
  return {douyinDiagnostics,startHeadedDouyin,headedDouyinProgress,headedDouyinDisplay,cancelHeadedDouyin,disconnectHeadedDouyin,checkBili,checkDouyin,startBili,pollBili,startDouyin,cancelDouyin,douyinProgress,biliPng:()=>biliSession?.png || null,douyinPng:()=>{if (!dySession || dySession.done || dySession.pending || dySession.challenge) return null; try {const status=JSON.parse(fs.readFileSync(path.join(dySession.dir,'status.json'),'utf8')).status; if (status !== 'ready') return null; const qr=path.join(dySession.dir,'qr.png'); if (Date.now()-fs.statSync(qr).mtimeMs >= 60000) return null; return fs.readFileSync(qr);}catch{return null;}}};
}