/**
 * 小鱼浏览器屏幕只读观察器（Browser Observer - Read Only）
 *
 * 1. 严格只读旁观视角：只捕获画面帧，绝不提供任何键鼠注入/交互接口，保证不干扰小鱼自主上网。
 * 2. 统一监听并挂载活动浏览器页面（B站播放器、抖音精选流、网页检索）。
 * 3. 当小鱼打开电脑浏览时，毫秒级抓取最新画面；当小鱼在床上待机时，返回电脑休眠待机屏保。
 * 4. 提供 HTTP 静态流（/api/browser/screen.jpg）与 MJPEG 连续视频流（/api/browser/stream.mjpg）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const STANDBY_IMG = '/root/ai-companion-xiaoyu/ai-companion-kit/packages/companion/public/room_assets/screen_standby.jpg';

/** 新帧广播：MJPEG 端点订阅它，浏览器推一帧就转发一帧 */
export const frameBus = new EventEmitter();
frameBus.setMaxListeners(20);

let activePage = null;
let activeInfo = {
  platform: 'none',
  title: '电脑待机中',
  url: '',
  updatedAt: Date.now(),
};

let lastCachedBuffer = null;
let lastCaptureTime = 0;

// ── CDP 屏幕串流：比 page.screenshot() 快一个量级，视频播放时能到 20~30fps ──
let cdpSession = null;
let screencastPage = null;
let screencastFrameCount = 0;
let screencastFpsAt = Date.now();
let fpsWindow = [];
let lastEmitAt = 0;

async function startScreencast(page) {
  if (screencastPage === page && cdpSession) return;
  await stopScreencast();
  try {
    const session = await page.context().newCDPSession(page);
    session.on('Page.screencastFrame', async (frame) => {
      try {
        const now = Date.now();

        // 节流到 30fps：CDP 有时会推得更快，没必要全转发，省带宽也省前端解码
        if (now - lastEmitAt >= 30) {
          lastEmitAt = now;
          lastCachedBuffer = Buffer.from(frame.data, 'base64');
          lastCaptureTime = now;
          activeInfo.updatedAt = now;
          frameBus.emit('frame', lastCachedBuffer);

          fpsWindow.push(now);
          const cut = now - 3000;
          if (fpsWindow.length && fpsWindow[0] < cut) fpsWindow = fpsWindow.filter((x) => x >= cut);
        }

        screencastFrameCount += 1;
        if (now - screencastFpsAt >= 5000) {
          const fps = (screencastFrameCount * 1000) / (now - screencastFpsAt);
          if (fps < 5) console.log(`[Observer] 串流帧率 ${fps.toFixed(1)}fps（画面基本静止，属正常）`);
          screencastFrameCount = 0;
          screencastFpsAt = now;
        }

        await session.send('Page.screencastFrameAck', { sessionId: frame.sessionId });
      } catch {}
    });

    await session.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 60,
      maxWidth: 1024,
      maxHeight: 640,
      everyNthFrame: 1,
    });

    cdpSession = session;
    screencastPage = page;
    screencastFrameCount = 0;
    screencastFpsAt = Date.now();
    console.log('[Observer] 已开启 CDP 屏幕串流（最高 30fps）');
  } catch (e) {
    console.log('[Observer] 串流启动失败，降级为截图模式:', e.message);
  }
}

async function stopScreencast() {
  const session = cdpSession;
  cdpSession = null;
  screencastPage = null;
  if (!session) return;
  try { await session.send('Page.stopScreencast'); } catch {}
  try { await session.detach(); } catch {}
}

export function isScreencasting() {
  return Boolean(cdpSession);
}

export function registerActivePage(page, { platform = 'browser', title = '', url = '' } = {}) {
  activePage = page;
  activeInfo = {
    platform,
    title: title || '正在浏览网页',
    url: url || '',
    updatedAt: Date.now(),
  };
  console.log(`[Observer] 观察器已挂载活动页面: [${platform}] ${activeInfo.title}`);
  startScreencast(page).catch((e) => console.log('[Observer] 串流启动异常:', e.message));
}

export function unregisterActivePage(page) {
  if (activePage === page) {
    activePage = null;
    activeInfo.platform = 'none';
    activeInfo.title = '电脑待机休眠中';
    activeInfo.updatedAt = Date.now();
    console.log('[Observer] 观察器卸载页面，恢复待机状态');
    stopScreencast();
  }
}

export function updatePageMeta({ title, url } = {}) {
  if (title) activeInfo.title = title;
  if (url) activeInfo.url = url;
  activeInfo.updatedAt = Date.now();
}

export function saveSnapshot(buf, meta = {}) {
  if (buf) {
    lastCachedBuffer = buf;
    lastCaptureTime = Date.now();
    if (meta.platform) activeInfo.platform = meta.platform;
    if (meta.title) activeInfo.title = meta.title;
    activeInfo.updatedAt = Date.now();
  }
}

/**
 * 获取当前屏幕截图二进制流（带防抖和缓存）
 */
export async function getLatestScreenBuffer() {
  const now = Date.now();

  // 0. 串流模式：直接返回 CDP 刚推来的帧，不做防抖，帧率才上得去
  if (cdpSession && lastCachedBuffer && now - lastCaptureTime < 3000) {
    return { buffer: lastCachedBuffer, isLive: true, info: activeInfo };
  }

  // 1. 如果有活跃的无头浏览器页面，尝试抓取真实屏幕
  if (activePage) {
    try {
      if (typeof activePage.isClosed === 'function' && !activePage.isClosed()) {
        // 500ms 缓存防抖，避免多人同时刷屏引起高频截屏
        if (lastCachedBuffer && (now - lastCaptureTime < 500)) {
          return { buffer: lastCachedBuffer, isLive: true, info: activeInfo };
        }
        const buf = await activePage.screenshot({
          type: 'jpeg',
          quality: 75,
          timeout: 4000,
        });
        lastCachedBuffer = buf;
        lastCaptureTime = now;
        return { buffer: buf, isLive: true, info: activeInfo };
      } else {
        activePage = null;
      }
    } catch (e) {
      // 页面可能刚关闭
      activePage = null;
    }
  }

  // 2. 如果最近 2 分钟内有截屏缓存，可以展示最近一次看过的画面
  if (lastCachedBuffer && (now - lastCaptureTime < 120000)) {
    return { buffer: lastCachedBuffer, isLive: false, info: { ...activeInfo, title: activeInfo.title + ' (刚才的画面)' } };
  }

  // 3. 否则读取待机屏保
  try {
    if (fs.existsSync(STANDBY_IMG)) {
      const buf = fs.readFileSync(STANDBY_IMG);
      return { buffer: buf, isLive: false, info: activeInfo };
    }
  } catch {}

  return { buffer: null, isLive: false, info: activeInfo };
}

export function getObserverStatus() {
  const isLive = Boolean(activePage && (!activePage.isClosed || !activePage.isClosed()));
  return {
    isLive,
    platform: activeInfo.platform,
    title: activeInfo.title,
    url: activeInfo.url,
    updatedAt: activeInfo.updatedAt,
    streaming: Boolean(cdpSession),
    fps: cdpSession ? Math.round((fpsWindow.length / 3) * 10) / 10 : 0,
  };
}

export default {
  registerActivePage,
  unregisterActivePage,
  updatePageMeta,
  getLatestScreenBuffer,
  getObserverStatus,
};
