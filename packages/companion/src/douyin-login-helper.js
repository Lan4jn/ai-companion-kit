import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { saveSnapshot, updatePageMeta } from './browser-observer.js';

const CHROME_PATH = '/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome';
const DATA_DIR = '/root/ai-companion-xiaoyu/ai-companion-kit/packages/companion/data';
const COOKIE_FILE = path.join(DATA_DIR, 'douyin-cookies.json');
const QR_PATH = '/root/.hermes/cache/scratch/douyin_qr.png';
const PUBLIC_QR_PATH = '/root/ai-companion-xiaoyu/ai-companion-kit/packages/companion/public/room_assets/douyin_qr.png';

async function main() {
  console.log('[DouyinLogin] 启动无头浏览器准备登录二维码...');
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 }
  });

  const page = await context.newPage();

  console.log('[DouyinLogin] 访问抖音精选推荐流...');
  await page.goto('https://www.douyin.com/?recommend=1', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  // 点击登录按钮
  await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('button, div, span, a'));
    const btn = all.find(el => el.innerText && el.innerText.trim() === '登录' && el.offsetHeight > 10);
    if (btn) btn.click();
  });

  console.log('[DouyinLogin] 等待 get_qrcode 接口响应...');
  try {
    await page.waitForResponse(res => res.url().includes('/passport/web/get_qrcode/'), { timeout: 15000 });
  } catch (e) {
    console.log('[DouyinLogin] 等待接口超时，继续检测 DOM');
  }

  // 留 2.5 秒让 canvas 完成黑白点阵绘制
  await page.waitForTimeout(2500);

  // 截取精准二维码区域 (w: 1280, h: 800 下精准坐标)
  const clipBox = {
    x: Math.round(1280 * 0.28),
    y: Math.round(800 * 0.38),
    width: Math.round(1280 * 0.155),
    height: Math.round(800 * 0.24)
  };

  fs.mkdirSync('/root/.hermes/cache/scratch', { recursive: true });
  fs.mkdirSync(path.dirname(PUBLIC_QR_PATH), { recursive: true });

  await page.screenshot({
    path: QR_PATH,
    clip: clipBox
  });

  fs.copyFileSync(QR_PATH, PUBLIC_QR_PATH);
  console.log('QR_READY:' + QR_PATH);

  // 轮询等待扫码登录成功（最多等 180 秒）
  const startTime = Date.now();
  let loggedIn = false;

  while (Date.now() - startTime < 180000) {
    await page.waitForTimeout(2500);
    const cookies = await context.cookies();
    const hasSession = cookies.some(c => c.name === 'sessionid' || c.name === 'passport_csrf_token' || c.name === 'LOGIN_STATUS');

    const isModalGone = await page.evaluate(() => {
      const text = document.body.innerText;
      return !text.includes('登录后免费畅享高清视频') && !text.includes('扫码登录');
    });

    if (hasSession && isModalGone) {
      console.log('[DouyinLogin] 🎉 检测到登录成功！正在保存 Cookie...');
      fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2), 'utf8');
      console.log('[DouyinLogin] ✅ Cookie 已成功保存至: ' + COOKIE_FILE);
      loggedIn = true;
      break;
    }

    // 更新只读监控画面
    try {
      const snap = await page.screenshot({ type: 'jpeg', quality: 70 });
      saveSnapshot(snap, { platform: 'douyin_login', title: '抖音扫码登录中 (等待扫描...)' });
    } catch {}
  }

  if (!loggedIn) {
    console.log('[DouyinLogin] 超过等待时间，未检测到扫码成功。');
  }

  await browser.close();
}

main().catch(e => {
  console.error('[DouyinLogin] 失败:', e);
  process.exit(1);
});
