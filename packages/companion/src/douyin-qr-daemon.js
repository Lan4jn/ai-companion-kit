/**
 * 抖音扫码与安全验证全自动守护进程（Douyin QR & SMS Verification Daemon - V2）
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const CHROME_PATH = '/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome';
const DATA_DIR = '/root/ai-companion-xiaoyu/ai-companion-kit/packages/companion/data';
const COOKIE_FILE = path.join(DATA_DIR, 'douyin-cookies.json');
const STATUS_FILE = '/tmp/douyin_qr_status.json';
const SMS_FILE = '/tmp/douyin_sms_code.txt';
const TRIGGER_FILE = '/tmp/douyin_refresh_trigger.txt';

const QR_SCRATCH = '/root/.hermes/cache/scratch/douyin_qr_live.png';
const QR_PUBLIC = '/root/ai-companion-xiaoyu/ai-companion-kit/packages/companion/public/room_assets/douyin_qr_live.png';

function writeStatus(data) {
  try {
    fs.writeFileSync(STATUS_FILE, JSON.stringify({ ...data, updatedAt: Date.now() }, null, 2));
  } catch {}
}

async function startDaemon() {
  console.log('[DouyinDaemon] 启动无头浏览器建立长效会话...');
  writeStatus({ status: 'starting', msg: '正在打开浏览器建立会话...' });

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

  async function openLoginModal() {
    // 弹窗已经开着就别再点，点一下反而会把二维码关掉
    const alreadyOpen = await page.evaluate(() =>
      Boolean(document.querySelector('#login-full-panel')) ||
      (document.body ? document.body.innerText.includes('扫码登录') : false)
    ).catch(() => false);
    if (alreadyOpen) return;

    await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('*'));
      const btn = all.find(x => x.innerText?.trim() === '登录' && x.offsetHeight > 15 && x.offsetWidth > 30);
      if (btn) btn.click();
      else {
        const b2 = document.querySelector('.semi-button-primary');
        if (b2) b2.click();
      }
    });
  }

  async function saveQRShot() {
    try {
      const state = await page.evaluate(() => {
        const text = document.body ? document.body.innerText : '';
        const expired = text.includes('二维码失效') || text.includes('二维码已失效');
        const qrImg = Array.from(document.querySelectorAll('img')).find((img) => {
          const r = img.getBoundingClientRect();
          return r.width >= 140 && r.width <= 280 && Math.abs(r.width - r.height) <= 25
            && (img.getAttribute('src') || '').startsWith('data:image');
        });
        const canvases = Array.from(document.querySelectorAll('canvas')).filter((c) => {
          const r = c.getBoundingClientRect();
          return r.width >= 140 && r.width <= 280 && Math.abs(r.width - r.height) <= 25;
        });
        return {
          expired,
          qrDataUrl: qrImg ? qrImg.getAttribute('src') : '',
          canvasCount: canvases.length,
        };
      });

      if (state.expired) {
        console.log('[DouyinDaemon] 警告：页面当前为失效蒙层，拒绝保存废码！');
        return false;
      }

      // 二维码本身就是 base64 图片，直接落盘，比按坐标截图更清晰也不会截错区域
      if (state.qrDataUrl && state.qrDataUrl.includes(',')) {
        const b64 = state.qrDataUrl.split(',')[1];
        fs.writeFileSync(QR_SCRATCH, Buffer.from(b64, 'base64'));
        fs.copyFileSync(QR_SCRATCH, QR_PUBLIC);
        console.log('[DouyinDaemon] ✅ 已从页面直接提取二维码原图');
        return true;
      }

      if (state.canvasCount > 0) {
        const handle = await page.evaluateHandle(() => {
          const list = Array.from(document.querySelectorAll('canvas')).filter((c) => {
            const r = c.getBoundingClientRect();
            return r.width >= 140 && r.width <= 280 && Math.abs(r.width - r.height) <= 25;
          });
          return list[0] || null;
        });
        const el = handle.asElement();
        if (el) {
          await el.screenshot({ path: QR_SCRATCH });
          fs.copyFileSync(QR_SCRATCH, QR_PUBLIC);
          console.log('[DouyinDaemon] ✅ 已截取二维码画布');
          return true;
        }
      }

      console.log('[DouyinDaemon] 未找到二维码元素（弹窗可能没打开）');
      return false;
    } catch (e) {
      console.error('[DouyinDaemon] 截取异常:', e.message);
      return false;
    }
  }

  async function saveModalShot() {
    try {
      const clip = { x: 380, y: 150, width: 520, height: 500 };
      await page.screenshot({ path: QR_SCRATCH, clip });
      fs.copyFileSync(QR_SCRATCH, QR_PUBLIC);
    } catch {}
  }

  async function reloadFreshQR() {
    console.log('[DouyinDaemon] 触发完整页面重载获取绝对新鲜二维码...');
    try {
      writeStatus({ status: 'refreshing', msg: '正在重新生成最新二维码...' });
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);
      await openLoginModal();
      await page.waitForTimeout(8000);
      const ok = await saveQRShot();
      if (ok) {
        writeStatus({ status: 'ready', msg: '二维码已就绪，会话持续保持中，请扫码！' });
      }
    } catch (e) {
      console.error('[DouyinDaemon] 重载异常:', e.message);
    }
  }

  writeStatus({ status: 'navigating', msg: '正在打开抖音精选...' });
  await page.goto('https://www.douyin.com/?recommend=1', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  await openLoginModal();
  console.log('[DouyinDaemon] 等待二维码生成...');
  await page.waitForTimeout(9000);

  let ok = await saveQRShot();
  if (!ok) {
    console.log('[DouyinDaemon] 首次截图失败，重开登录弹窗再试...');
    await openLoginModal();
    await page.waitForTimeout(4000);
    ok = await saveQRShot();
  }
  writeStatus(
    ok
      ? { status: 'ready', msg: '二维码已就绪，请使用抖音 App 扫一扫！' }
      : { status: 'waiting_modal', msg: '正在等待登录弹窗出现…' }
  );

  const startTime = Date.now();
  let lastRefresh = Date.now();
  let lastResend = 0;

  while (Date.now() - startTime < 1800000) {
    await page.waitForTimeout(1500);

    // 0. 检查是否有手动触发刷新指令
    if (fs.existsSync(TRIGGER_FILE)) {
      try { fs.unlinkSync(TRIGGER_FILE); } catch {}
      console.log('[DouyinDaemon] 收到前端手动刷新信号！');
      await reloadFreshQR();
      lastRefresh = Date.now();
      continue;
    }

    // 1. 检查是否登录成功 (必须真实 sessionid)
    let cookies = [];
    try { cookies = await context.cookies(); } catch {}
    const hasSession = cookies.some(c => c.name === 'sessionid' && c.value && c.value.length > 5);

    let isModalGone = false;
    let pageState = null;

    try {
      isModalGone = await page.evaluate(() => {
        const text = document.body ? document.body.innerText : '';
        return !text.includes('登录后免费畅享高清视频') && !text.includes('扫码登录') && !text.includes('身份验证') && !text.includes('接收短信验证码');
      });

      pageState = await page.evaluate(() => {
        const text = document.body ? document.body.innerText : '';
        const hasChooseVerify = text.includes('身份验证') && text.includes('接收短信验证码') && !text.includes('短信已发送');
        const hasInputSms = text.includes('接收短信验证码') && (text.includes('短信已发送') || text.includes('重新发送') || document.querySelector('input[placeholder*="验证码"]') !== null);
        const isQrScreen = text.includes('扫码登录') || Boolean(document.querySelector('canvas'));
        const isExpired = text.includes('二维码失效') || text.includes('二维码已过期') || text.includes('点击刷新');
        return { hasChooseVerify, hasInputSms, isQrScreen, isExpired };
      });
    } catch {
      continue;
    }

    if (hasSession && isModalGone) {
      console.log('[DouyinDaemon] 🎉 登录完全成功！写入 Cookie...');
      fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2), 'utf8');
      writeStatus({ status: 'success', msg: '🎉 登录成功！Cookie 已永久保存。' });
      break;
    }

    // 阶段 A: 二次身份验证选择页 -> 自动点击“接收短信验证码”
    if (pageState.hasChooseVerify) {
      console.log('[DouyinDaemon] 检测到身份验证选项，自动点击【接收短信验证码】...');
      await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('*'));
        const el = all.find(e => e.innerText && e.innerText.trim() === '接收短信验证码' && e.offsetHeight > 10);
        if (el) el.click();
      });
      await page.waitForTimeout(2000);
      await saveModalShot();
      writeStatus({ status: 'need_sms', msg: '📱 短信验证码已发送至你的手机，请输入验证码完成登录！' });
      continue;
    }

    // 阶段 B: 输入验证码页 -> 检测是否有待提交的验证码
    if (pageState.hasInputSms) {
      // 上一轮输错了就自动点“重新发送”，否则用户拿着废码怎么输都失败
      const smsError = await page.evaluate(() => {
        const t = document.body ? document.body.innerText : '';
        return t.includes('验证码错误') || t.includes('验证失败');
      }).catch(() => false);

      if (smsError && Date.now() - lastResend > 60000) {
        console.log('[DouyinDaemon] 页面提示验证码错误，自动重新发送...');
        await page.evaluate(() => {
          const el = Array.from(document.querySelectorAll('*')).find(
            (e) => e.innerText?.trim() === '重新发送' && e.offsetHeight > 8
          );
          if (el) el.click();
        });
        lastResend = Date.now();
        await page.waitForTimeout(2500);
        await saveModalShot();
        writeStatus({ status: 'need_sms_retry', msg: '📱 验证码错误，已重新发送，请重新输入！' });
        continue;
      }

      writeStatus({ status: 'need_sms', msg: '📱 短信验证码已下发，请在网页或 QQ 发送 6 位验证码！' });

      if (fs.existsSync(SMS_FILE)) {
        const code = fs.readFileSync(SMS_FILE, 'utf8').trim();
        if (code && /^\d{4,8}$/.test(code)) {
          console.log(`[DouyinDaemon] 收到待提交验证码（${code.length} 位），正在填入...`);
          try { fs.unlinkSync(SMS_FILE); } catch {}

          try {
            await page.evaluate((c) => {
              const input = document.querySelector('#uc-second-verify input') || document.querySelector('input[placeholder*="验证码"]');
              if (input) {
                const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                if (nativeSetter) nativeSetter.call(input, c);
                else input.value = c;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
              }
            }, code);

            await page.mouse.click(550, 320);
            await page.waitForTimeout(200);
            await page.keyboard.press('Control+A');
            await page.keyboard.press('Backspace');
            await page.keyboard.type(code, { delay: 60 });
            await page.waitForTimeout(300);

            await page.evaluate(() => {
              const btns = Array.from(document.querySelectorAll('#uc-second-verify button, #uc-second-verify div, #uc-second-verify span, button, div, span'));
              const btn = btns.find(b => b.innerText?.trim() === '验证' && b.offsetHeight > 10);
              if (btn) btn.click();
            });
            await page.mouse.click(715, 450);
          } catch (fillErr) {
            console.error('[DouyinDaemon] 填入验证码非致命异常:', fillErr.message);
          }

          await page.waitForTimeout(3000);
          await saveModalShot();

          const ck = await context.cookies();
          if (ck.some(c => c.name === 'sessionid' && c.value && c.value.length > 5)) {
            console.log('[DouyinDaemon] 🎉 验证码校验成功！登录已完成！');
            fs.writeFileSync(COOKIE_FILE, JSON.stringify(ck, null, 2), 'utf8');
            writeStatus({ status: 'success', msg: '🎉 登录成功！Cookie 已永久保存。' });
            break;
          }
        }
      }
      continue;
    }

    // 阶段 C: 二维码页面 -> 过期或超过 60 秒自动重新获取新鲜码
    if (pageState.isQrScreen) {
      if (pageState.isExpired || (Date.now() - lastRefresh > 60000)) {
        console.log('[DouyinDaemon] 二维码已超时或失效，开始重新获取...');
        await reloadFreshQR();
        lastRefresh = Date.now();
      }
    } else if (Date.now() - lastRefresh > 20000) {
      // 弹窗被关掉/没弹出来：主动重开并重新截图，别让页面上挂着废图
      console.log('[DouyinDaemon] 未检测到二维码界面，尝试重开登录弹窗...');
      await page.evaluate(() => {
        const close = document.querySelector('#login-full-panel [aria-label="关闭"], .semi-modal-close');
        if (close) close.click();
      }).catch(() => {});
      await openLoginModal();
      await page.waitForTimeout(2500);
      const ok = await saveQRShot();
      writeStatus(
        ok
          ? { status: 'ready', msg: '二维码已就绪，请使用抖音 App 扫一扫！' }
          : { status: 'waiting_modal', msg: '正在等待登录弹窗出现…' }
      );
      lastRefresh = Date.now();
    }
  }

  console.log('[DouyinDaemon] 会话结束，关闭浏览器');
  await browser.close();
}

startDaemon().catch(e => {
  console.error('[DouyinDaemon] 异常退出:', e);
  writeStatus({ status: 'error', msg: e.message });
  process.exit(1);
});
