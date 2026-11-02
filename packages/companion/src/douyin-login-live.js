import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { saveSnapshot, updatePageMeta } from './browser-observer.js';

const CHROME_PATH = '/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome';
const DATA_DIR = '/root/ai-companion-xiaoyu/ai-companion-kit/packages/companion/data';
const COOKIE_FILE = path.join(DATA_DIR, 'douyin-cookies.json');
const QR_PATH = '/root/.hermes/cache/scratch/douyin_qr_live.png';
const PUBLIC_QR_PATH = '/root/ai-companion-xiaoyu/ai-companion-kit/packages/companion/public/room_assets/douyin_qr_live.png';

async function run() {
  console.log('[DouyinLogin] 启动无头浏览器准备新鲜二维码...');
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

  console.log('[DouyinLogin] 正在打开抖音精选并触发登录...');
  await page.goto('https://www.douyin.com/?recommend=1', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  // 点击登录按钮
  await page.evaluate(() => {
    const btn = document.querySelector('.semi-button-primary');
    if (btn) btn.click();
    else {
      const all = Array.from(document.querySelectorAll('*'));
      const el = all.find(x => x.innerText && x.innerText.trim() === '登录' && x.offsetHeight > 10);
      if (el) el.click();
    }
  });

  console.log('[DouyinLogin] 等待二维码生成 (10秒)...');
  await page.waitForTimeout(10000);

  // 截取精准二维码区域
  const clip = {
    x: 365,
    y: 312,
    width: 186,
    height: 196
  };

  fs.mkdirSync('/root/.hermes/cache/scratch', { recursive: true });
  fs.mkdirSync(path.dirname(PUBLIC_QR_PATH), { recursive: true });

  await page.screenshot({ path: QR_PATH, clip });
  fs.copyFileSync(QR_PATH, PUBLIC_QR_PATH);

  // 同时更新监视器画面
  try {
    const fullShot = await page.screenshot({ type: 'jpeg', quality: 75 });
    saveSnapshot(fullShot, { platform: 'douyin_login', title: '抖音扫码登录中 (等待扫描...)' });
  } catch {}

  console.log('LIVE_QR_READY:' + QR_PATH);

  // 保持会话活跃并轮询登录凭证（最多等 180 秒）
  const startTime = Date.now();
  let loggedIn = false;

  while (Date.now() - startTime < 180000) {
    await page.waitForTimeout(2000);
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

      // 截取一张登录后的个人主页状态
      try {
        await page.waitForTimeout(2000);
        const loggedShot = await page.screenshot({ type: 'jpeg', quality: 75 });
        saveSnapshot(loggedShot, { platform: 'douyin_logged_in', title: '抖音已成功登录' });
      } catch {}
      break;
    }
  }

  if (!loggedIn) {
    console.log('[DouyinLogin] 会话超时（180秒），登录未完成。');
  }

  await browser.close();
}

run().catch(e => {
  console.error('[DouyinLogin] 失败:', e);
  process.exit(1);
});
