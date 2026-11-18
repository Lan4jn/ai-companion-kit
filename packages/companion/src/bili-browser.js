import { biliPrivacyBlock } from './bili-privacy.js';
import { reserveComment } from './bili-comment-ledger.js';
import { isEmptyPublicFishCliche } from './public-comment-naturalness.js';
/**
 * 用真浏览器看视频。
 *
 * 为什么要这个：走 API 拉流下载，B 站只看到"有人请求了文件"，跟下载器没区别 ——
 * 不写历史、不报播放进度、不参与推荐权重。真浏览器播放才会像人一样留痕。
 *
 * 设计取舍：
 *   - 浏览器实例复用（启动一次约 12s，每个视频复用省掉这笔开销）
 *   - 每个视频开一个独立 context，看完就关，不泄漏状态
 *   - 播 seconds 秒（默认 20s），倍速 rate（默认 2x），覆盖实际内容的 rate×seconds
 *   - 失败不抛异常，返回 {ok:false}，让上层回退到 API 心跳
 */
import { chromium } from 'playwright-core';
import { registerActivePage, unregisterActivePage } from './browser-observer.js';
import { openFragmentVault } from './bili-fragment-vault.js';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH || '/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let _browser = null;
let _launching = null;

async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  if (_launching) return _launching;
  _launching = (async () => {
    _browser = await chromium.launch({
      executablePath: CHROME,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--autoplay-policy=no-user-gesture-required',
        '--mute-audio',
        '--disable-blink-features=AutomationControlled',
        '--lang=zh-CN',
      ],
    });
    return _browser;
  })();
  try {
    return await _launching;
  } finally {
    _launching = null;
  }
}

function cookieList(cred) {
  return [
    { name: 'SESSDATA', value: cred.sessdata, domain: '.bilibili.com', path: '/' },
    { name: 'bili_jct', value: cred.bili_jct, domain: '.bilibili.com', path: '/' },
    { name: 'buvid3', value: cred.buvid3, domain: '.bilibili.com', path: '/' },
    { name: 'DedeUserID', value: cred.dedeuserid || cred.DedeUserID, domain: '.bilibili.com', path: '/' },
  ].filter((c) => c.value);
}

/**
 * 在真浏览器里看一个视频。
 * @param {string} bvid
 * @param {object} cred  {sessdata, bili_jct, buvid3, dedeuserid}
 * @param {object} opts  {seconds=20, rate=2, screenshot=false}
 * @returns {Promise<{ok:boolean, watched?:number, duration?:number, shot?:string, error?:string}>}
 */
export function playbackEvidence({ start, end, played }) {
  if (![start, end, played].every(Number.isFinite) || played <= 0 || end <= start) return 0;
  return Math.min(played, end - start);
}

export function continuousPlaybackEvidence(samples, interrupted = false) {
  if (interrupted || !Array.isArray(samples) || samples.length < 2) return { complete: false };
  const first = samples[0], last = samples.at(-1);
  if (!Number.isFinite(first.duration) || first.duration <= 0 || !Number.isFinite(first.rate) || first.rate <= 0 || first.time < 0 || first.time > 0.15) return { complete: false };
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i], prev = samples[i-1];
    if (![s.time, s.wall, s.duration, s.rate].every(Number.isFinite) || s.identity !== true || s.seeking || (s.paused && !s.ended) || s.duration <= 0 || Math.abs(s.duration-first.duration) > 1 || s.time < 0 || s.time > s.duration + 0.15 || s.rate!==first.rate) return { complete: false };
    if (prev && (s.wall <= prev.wall || s.wall - prev.wall > 1 || s.time < prev.time - 0.05 || s.time - prev.time > (s.wall-prev.wall)*first.rate + 0.3)) return { complete: false };
  }
  return { complete: Boolean(last.ended && last.time >= last.duration - 0.15 && last.time - first.time <= (last.wall - first.wall) * first.rate + 0.3), start: first.time, end: last.time, duration: last.duration };
}

// Record in an evaluation closure and catch native ended before target autoplay handlers.
export async function watchVideoPage(page, { seconds = 20, rate = 2, expectedDuration, onProgress, fragment } = {}) {
  const binding = `__biliProgress${Date.now()}${Math.floor(Math.random()*1e9)}`;
  if (typeof onProgress === 'function') await page.exposeFunction(binding, async snapshot => {
    const p = continuousPlaybackEvidence(snapshot.samples, snapshot.interrupted);
    if (!Number.isFinite(expectedDuration) || Math.abs(p.duration - expectedDuration) > 1 ||
        !Number.isFinite(p.end) || p.end <= p.start || snapshot.samples.some(s => s.ad !== false || s.ended) ||
        !snapshot.ranges?.some(([start,end]) => start <= p.start + 0.15 && end >= p.end - 0.15)) return 'continue';
    try { return await onProgress({ start:p.start, end:p.end, duration:p.duration }) === 'skip' ? 'skip' : 'continue'; }
    catch { return 'continue'; }
  });
  const trace = await page.evaluate(async ({ seconds, rate, binding, progressEnabled }) => {
    const v = document.querySelector('video');
    if (!v) return null;
    // Let the page finish its initial player setup before taking ownership.
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const until = performance.now() + 30000;
    let stableSince = 0, previous = '';
    while (performance.now() < until) {
      const key = `${v.currentSrc || v.src}|${v.duration}`;
      const ready = v.isConnected && document.querySelectorAll('video').length === 1 && document.querySelector('video') === v && (v.currentSrc || v.src) && Number.isFinite(v.duration) && v.duration > 0 && v.readyState >= 2 && !v.seeking;
      if (!ready || key !== previous) { stableSince = 0; previous = key; }
      else if (!stableSince) stableSince = performance.now();
      if (stableSince && performance.now() - stableSince >= 1500) break;
      await sleep(100);
    }
    if (!stableSince || performance.now() - stableSince < 1500) return null;
    const visible = () => {
      const rect = v.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || rect.right <= 0 || rect.bottom <= 0 || rect.left >= innerWidth || rect.top >= innerHeight) return false;
      for (let node = v; node && node.nodeType === 1; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) return false;
      }
      return true;
    };
    const src = v.currentSrc || v.src, href = location.href;
    const valid = () => v.isConnected && document.querySelectorAll('video').length === 1 && document.querySelector('video') === v && (v.currentSrc || v.src) === src && location.href === href && visible();
    v.pause();
    // Install the listener before issuing a real seek, including when already at zero.
    const rewound = await new Promise(resolve => {
      let done = false;
      const finish = ok => { if (done) return; done = true; clearTimeout(timeout); v.removeEventListener('seeked', onSeeked); resolve(ok); };
      const onSeeked = event => finish(event.isTrusted && !v.seeking);
      const timeout = setTimeout(() => finish(false), 5000);
      v.addEventListener('seeked', onSeeked);
      try { v.currentTime = 0; } catch { finish(false); }
    });
    if (!rewound) return null;
    let disturbed = false;
    const disturb = event => { if (event.target === v) disturbed = true; };
    for (const type of ['seeking','play','loadstart','emptied']) v.addEventListener(type, disturb);
    for (let i = 0; i < 5; i++) {
      await sleep(100);
      if (!valid() || !v.paused || v.seeking || Math.abs(v.currentTime) > 0.001) disturbed = true;
    }
    for (const type of ['seeking','play','loadstart','emptied']) v.removeEventListener(type, disturb);
    if (disturbed) return null;
    const samples = [];
    let interrupted = false, started = false, finished = false, skipped = false, deciding = false, lastDecision = 0, timer, deadline;
    // Sampling alone misses ads or player replacement that appear and disappear
    // between ticks. Conservatively invalidate the entire observation.
    const adSelector = '.bpx-player-ad, .bilibili-player-video-state-ad, .bpx-player-ad-wrap, [class*="player-ad-"]';
    const hasAd = node => node?.nodeType === 1 && (node.matches(adSelector) || node.querySelector(adSelector));
    const inspectMutations = records => {
      for (const record of records) {
        const nodes = [...record.addedNodes, ...record.removedNodes];
        if (!identity() || document.querySelector(adSelector) || nodes.some(hasAd) ||
            nodes.some(node => node === v || (node?.nodeType === 1 && (node.matches('video') || node.querySelector('video')))) ||
            (record.type === 'attributes' && record.target === v && record.attributeName === 'src') ||
            (record.type === 'attributes' && record.attributeName === 'class' &&
             /(?:bpx-player-ad|bilibili-player-video-state-ad|player-ad-)/.test(record.oldValue || ''))) interrupted = true;
      }
    };
    const monitor = new MutationObserver(inspectMutations);
    monitor.observe(document, {subtree:true, childList:true, attributes:true, attributeOldValue:true, attributeFilter:['class','src']});
    const played = () => { let n = 0; for (let i=0; i<v.played.length; i++) n += v.played.end(i)-v.played.start(i); return n; };
    const baseline = { time:v.currentTime, played:played() };
    const identity = valid;
    const sample = (ended = false) => {
      const ad = Boolean(document.querySelector('.bpx-player-ad, .bilibili-player-video-state-ad, .bpx-player-ad-wrap, [class*="player-ad-"]'));
      samples.push({time:v.currentTime, wall:performance.now()/1000, duration:v.duration, rate:v.playbackRate,
        paused:v.paused, ended, seeking:v.seeking, identity:identity(), ad});
    };
    return await new Promise(resolve => {
      const done = () => {
        if (finished) return;
        inspectMutations(monitor.takeRecords()); monitor.disconnect();
        finished = true; clearInterval(timer); clearTimeout(deadline);
        for (const type of ['ended','playing','seeking','ratechange','emptied','loadstart','pause']) document.removeEventListener(type, onEvent, true);
        const ranges = []; for (let i=0; i<v.played.length; i++) ranges.push([v.played.start(i), v.played.end(i)]);
        resolve({ samples, interrupted, baseline, skipped, final:{time:v.currentTime, played:played(), duration:v.duration, ranges} });
      };
      const onEvent = event => {
        if (event.target !== v || !started || finished) return;
        if (event.type === 'playing') {
          if (event.isTrusted && !timer) { sample(); timer = setInterval(() => {
            sample();
            if (!progressEnabled || deciding || interrupted || v.paused || v.ended || v.currentTime - lastDecision < 1) return;
            deciding = true; lastDecision = v.currentTime;
            const ranges = []; for (let i=0; i<v.played.length; i++) ranges.push([v.played.start(i), v.played.end(i)]);
            Promise.resolve(window[binding]({samples: samples.slice(), interrupted, ranges})).then(choice => {
              if (choice === 'skip' && !finished && !interrupted && identity() && !v.paused && !v.seeking && !v.ended && samples.every(s => s.ad === false) && !document.querySelector('.bpx-player-ad, .bilibili-player-video-state-ad, .bpx-player-ad-wrap, [class*="player-ad-"]')) {
                skipped = true; done(); v.pause();
              }
            }).catch(() => {}).finally(() => { deciding = false; });
          }, 250); }
        } else if (event.type === 'ended') {
          if (event.isTrusted && v.ended && identity()) { sample(true); done(); }
        } else if (!(event.type === 'pause' && v.ended) && !(event.type === 'ratechange' && v.playbackRate === rate)) interrupted = true;
      };
      for (const type of ['ended','playing','seeking','ratechange','emptied','loadstart','pause']) document.addEventListener(type, onEvent, true);
      v.muted = true; v.playbackRate = rate;
      deadline = setTimeout(() => { if (started && !finished) sample(); done(); }, Math.max(0, seconds)*1000);
      started = true;
      Promise.resolve(v.play()).catch(() => done());
    });
  }, { seconds, rate, binding, progressEnabled: typeof onProgress === 'function' });
  const playback = { ...continuousPlaybackEvidence(trace?.samples, trace?.interrupted), samples: trace?.samples, interrupted: Boolean(trace?.interrupted) };
  let watched = playbackEvidence({start:trace?.baseline?.time, end:trace?.final?.time, played:trace?.final?.played - trace?.baseline?.played});
  // TimeRanges are a union, so subtracting the old union discards replayed overlap.
  // Only a continuous, uninterrupted trace plus a range covering it can recover it.
  if (trace?.final?.ranges?.some(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && start <= playback.start + 0.15 && end >= playback.end - 0.15) && Number.isFinite(playback.end) && trace.samples.every(s => s.ad === false)) {
    const span = playback.end - playback.start;
    watched = playback.complete && !playback.interrupted ? span : Math.min(watched > 0 ? watched : span, span);
  }
  else watched = 0;
  const result = {playback, watched, skipped: trace?.skipped === true, duration: Number.isFinite(trace?.final?.duration) ? Math.round(trace.final.duration) : 0};
  // The same-UID JS process is trusted; model-returned playback objects are not.
  // Sign only here, immediately after the browser's validated observation.
  if (fragment && result.skipped && watched > 0 && !playback.interrupted &&
      Number.isFinite(expectedDuration) && Math.abs(playback.duration-expectedDuration)<=0.15 &&
      Number.isFinite(playback.start) && Number.isFinite(playback.end) && playback.end < playback.duration-0.15 &&
      Math.abs(watched-(playback.end-playback.start))<=0.3 && trace.samples.every(s=>s.ad===false && s.paused===false && s.ended===false && s.seeking===false) &&
      /^BV[A-Za-z0-9]{10}$/.test(fragment.bvid || '') && path.isAbsolute(fragment.dir || '') && Array.isArray(fragment.segments)) {
    try {
      const vault=openFragmentVault(path.join(fragment.dir,'bili-fragment-vault'));
      const browserResult={ok:true,skipped:true,watched,playback:{interrupted:false,samples:playback.samples.map(({time,wall,duration,rate,identity,seeking,paused,ended,ad})=>({time,wall,duration,rate,identity,seeking,paused,ended,ad}))}};
      result.fragments=fragment.segments.filter(s=>Number.isFinite(s.start) && Number.isFinite(s.end) && s.start>=0 && s.start>=playback.start-0.15 && s.end>s.start && s.end<=playback.end && typeof s.visual==='string' && s.visual.trim() && s.visual.length<=4000).map(({start,end,visual})=>{
        const payload={scope:fragment.scope,bvid:fragment.bvid,duration:expectedDuration,segment:{start,end,visual},browserResult};
        return {payload,token:vault.issue(payload)};
      });
    } catch { result.fragments=[]; }
  }
  return result;
}

export async function browserWatch(bvid, cred, opts = {}) {
  const { seconds = 20, rate = 2, screenshot = false } = opts;
  const t0 = Date.now();
  let ctx = null;
  let page = null;
  try {
    const browser = await getBrowser();
    ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: UA,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    });
    await ctx.addCookies(cookieList(cred));

    page = await ctx.newPage();
    registerActivePage(page, { platform: 'bilibili', title: `B站视频: ${bvid}`, url: `https://www.bilibili.com/video/${bvid}` });

    await page.goto(`https://www.bilibili.com/video/${bvid}`, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
    await page.waitForSelector('video', { timeout: 20000 });

    const { playback, watched, duration, skipped, fragments } = await watchVideoPage(page, { seconds, rate, expectedDuration: opts.expectedDuration, onProgress: opts.onProgress, fragment: opts.fragment });

    let shot = null;
    if (screenshot) {
      shot = `/tmp/bwatch_${bvid}_${Date.now()}.png`;
      await page.screenshot({ path: shot }).catch(() => { shot = null; });
    }

    return {
      ok: watched > 0,
      playback,
      watched,
      skipped,
      fragments,
      duration,
      shot,
      elapsed: Date.now() - t0,
    };
  } catch (e) {
    return { ok: false, error: e?.message || String(e), elapsed: Date.now() - t0 };
  } finally {
    if (page) unregisterActivePage(page);
    if (ctx) await ctx.close().catch(() => {});
  }
}


/**
 * 在真浏览器里发评论。
 *
 * 为什么不用接口：B 站对纯接口发评论的风控最严，新号直接被 shadow ban
 * （只有自己带 cookie 能看到，路人看不到）。走网页至少是真实浏览器指纹 + 真实点击。
 *
 * 注意：shadow ban 是账号层面的，网页发也不保证一定公开可见。
 */
export async function browserComment(bvid, text, cred, opts = {}) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, code: 'invalid_text' };
  if (Array.from(text).length > 50) return { ok: false, code: 'reply_too_long' };
  const blocked = biliPrivacyBlock(text, opts?.ownerIds);
  if (blocked) return blocked;
  if (isEmptyPublicFishCliche(text)) return { ok: false, code: 'public_comment_cliche', error: '空泛套话，跳过评论' };
  const { timeout = 70000, typeDelay = 90 } = opts;
  const t0 = Date.now();
  let ctx = null;
  try {
    const browser = await getBrowser();
    ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent: UA,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    });
    await ctx.addCookies(cookieList(cred));

    const page = await ctx.newPage();
    await page.goto(`https://www.bilibili.com/video/${bvid}`, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
    await page.waitForTimeout(3500);

    // 滚到评论区，触发懒加载
    await page.evaluate(() => {
      document.querySelector('#comment, bili-comments')?.scrollIntoView({ block: 'center' });
    });
    await page.waitForTimeout(4500);

    // contenteditable 编辑器（穿透 shadow DOM）
    const editor = page.locator('div.brt-editor').first();
    await editor.waitFor({ state: 'visible', timeout: 20000 });
    await editor.click();
    await page.waitForTimeout(500);

    // 逐字输入，像人打字
    await page.keyboard.type(text, { delay: typeDelay });
    await page.waitForTimeout(800);

    const typed = await editor.innerText().catch(() => '');
    if (!typed || !typed.trim() || typed !== text || Array.from(typed).length > 50) {
      return { ok: false, error: '输入框没吃进去', elapsed: Date.now() - t0 };
    }

    // 点发布
    const btn = page.locator('button:has-text("发布")').first();
    await btn.waitFor({ state: 'visible', timeout: 10000 });
    const disabled = await btn.evaluate((el) => el.disabled).catch(() => false);
    if (disabled) {
      return { ok: false, error: '发布按钮禁用（可能未登录或风控）', elapsed: Date.now() - t0 };
    }
    // Confirm the browser's loaded target rather than trusting a supplied aid/bvid pair.
    const loaded = await page.evaluate(() => ({ aid: window.__INITIAL_STATE__?.videoData?.aid, bvid: window.__INITIAL_STATE__?.videoData?.bvid }));
    if (String(loaded?.aid || '') !== String(opts.aid || '') || loaded?.bvid !== bvid) return { ok:false, code:'comment_target_unverified' };
    const reservation = reserveComment({ account: cred?.dedeuserid || cred?.DedeUserID, aid: opts.aid, message: text });
    if (!reservation.ok) return reservation;
    await btn.click();

    // 等结果：toast 提示 或 编辑器清空
    await page.waitForTimeout(4000);
    const after = await editor.innerText().catch(() => '');
    const cleared = !after || !after.trim();

    // 抓 toast 文案
    const toast = await page.evaluate(() => {
      const t = document.querySelector('.bili-toast, .b-toast, [class*="toast"]');
      return t ? (t.innerText || '').trim().slice(0, 60) : '';
    }).catch(() => '');

    // Cleared editor/toast does not prove a published comment exists.
    const ok = false;
    return {
      ok,
      cleared,
      toast,
      elapsed: Date.now() - t0,
      error: ok ? null : (toast || '未确认成功'),
    };
  } catch (e) {
    return { ok: false, error: e?.message || String(e), elapsed: Date.now() - t0 };
  } finally {
    if (ctx) await ctx.close().catch(() => {});
  }
}

export async function closeWatchBrowser() {
  if (_browser) {
    await _browser.close().catch(() => {});
    _browser = null;
  }
}

export function isBrowserReady() {
  return !!(_browser && _browser.isConnected());
}
