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
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STANDBY_IMG = path.resolve(__dirname, '../public/room_assets/screen_standby.jpg');

let activePage = null;
let activeInfo = {
  platform: 'none',
  title: '电脑待机中',
  url: '',
  updatedAt: Date.now(),
};

let lastCachedBuffer = null;
let lastCaptureTime = 0;

export function registerActivePage(page, { platform = 'browser', title = '', url = '' } = {}) {
  activePage = page;
  activeInfo = {
    platform,
    title: title || '正在浏览网页',
    url: url || '',
    updatedAt: Date.now(),
  };
  console.log(`[Observer] 观察器已挂载活动页面: [${platform}] ${activeInfo.title}`);
}

export function unregisterActivePage(page) {
  if (activePage === page) {
    activePage = null;
    activeInfo.platform = 'none';
    activeInfo.title = '电脑待机休眠中';
    activeInfo.updatedAt = Date.now();
    console.log('[Observer] 观察器卸载页面，恢复待机状态');
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
  };
}

export default {
  registerActivePage,
  unregisterActivePage,
  updatePageMeta,
  getLatestScreenBuffer,
  getObserverStatus,
};
