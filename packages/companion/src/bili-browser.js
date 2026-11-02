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

    // 开始播放（静音 + 倍速）
    await page.evaluate((r) => {
      const v = document.querySelector('video');
      if (!v) return;
      v.muted = true;
      v.playbackRate = r;
      v.play().catch(() => {});
    }, rate);

    await page.waitForTimeout(seconds * 1000);

    const state = await page.evaluate(() => {
      const v = document.querySelector('video');
      if (!v) return null;
      return {
        currentTime: Math.round(v.currentTime),
        duration: Math.round(v.duration || 0),
        paused: v.paused,
      };
    });

    let shot = null;
    if (screenshot) {
      shot = `/tmp/bwatch_${bvid}_${Date.now()}.png`;
      await page.screenshot({ path: shot }).catch(() => { shot = null; });
    }

    const watched = state?.currentTime || 0;
    return {
      ok: watched > 0,
      watched,
      duration: state?.duration || 0,
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
    if (!typed || !typed.trim()) {
      return { ok: false, error: '输入框没吃进去', elapsed: Date.now() - t0 };
    }

    // 点发布
    const btn = page.locator('button:has-text("发布")').first();
    await btn.waitFor({ state: 'visible', timeout: 10000 });
    const disabled = await btn.evaluate((el) => el.disabled).catch(() => false);
    if (disabled) {
      return { ok: false, error: '发布按钮禁用（可能未登录或风控）', elapsed: Date.now() - t0 };
    }
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

    const ok = cleared && !/失败|错误|频繁|稍后/.test(toast);
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
