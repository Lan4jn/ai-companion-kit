/**
 * 抖音扫码与安全验证全自动守护进程（Douyin QR & SMS Verification Daemon - V2）
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { decideQrAction, safeQrDiagnostic } from './douyin-qr-state.js';

const CHROME_PATH = '/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome';
export async function startDaemon({ sessionDir = process.env.DOUYIN_LOGIN_SESSION_DIR, headed = false, displayEnv, url = 'https://www.douyin.com/?recommend=1', delays = {}, signal, installTestContext, testChromePath } = {}) {
if (testChromePath !== undefined && (!process.env.NODE_TEST_CONTEXT || typeof installTestContext !== 'function' || !path.isAbsolute(testChromePath))) throw new Error('Test browser unavailable');
if (!sessionDir || !path.isAbsolute(sessionDir)) throw new Error('Private login session required');
const COOKIE_FILE = path.join(sessionDir, 'cookies.json');
const STATUS_FILE = path.join(sessionDir, 'status.json');
const QR_SCRATCH = path.join(sessionDir, 'qr.png');
process.umask(0o077);
let lastDiagnostic, diagnosticCount = 0;
function diagnostic(stage) {
  stage = safeQrDiagnostic(stage);
  if (stage === lastDiagnostic || diagnosticCount >= 128) return;
  lastDiagnostic = stage;
  diagnosticCount++;
  try { fs.appendFileSync(path.join(sessionDir, 'diagnostics.jsonl'), JSON.stringify({stage, at:Date.now()})+'\n', {mode:0o600}); } catch {}
}
function writeStatus(data) {
  diagnostic(({success:'candidate',need_sms:'challenge',error:'browser_error'})[data.status] || data.status);
  try { fs.writeFileSync(STATUS_FILE, JSON.stringify({ ...data, updatedAt: Date.now() }, null, 2)); } catch {}
}
  let browser;
  try {
  console.log('[DouyinDaemon] 启动无头浏览器建立长效会话...');
  writeStatus({ status: 'starting', msg: '正在打开浏览器建立会话...' });

  if (headed && (!displayEnv?.DISPLAY || !displayEnv?.XAUTHORITY)) throw new Error('Private display required');
  browser = await chromium.launch({
    executablePath: testChromePath || CHROME_PATH,
    headless: !headed,
    ...(headed ? {env:{...process.env,...displayEnv}} : {}),
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', ...(headed ? ['--kiosk'] : [])]
  });

  const abort = () => browser.close().catch(()=>{});
  if (signal?.aborted) throw new Error('cancelled');
  signal?.addEventListener('abort', abort, {once:true});
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: headed ? {width:1024,height:768} : { width: 1280, height: 800 },
    ...(installTestContext ? {serviceWorkers:'block'} : {})
  });
  // Injection is used only by offline fixtures; production headed entry remains
  // fail-closed, and this callback is not a network isolation boundary.
  if (installTestContext) await installTestContext(context);

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
    if (headed) return false; // Candidate never writes QR images or verification screenshots.
    try {
      const state = await page.evaluate(() => {
        const surfaces = Array.from(document.querySelectorAll('#login-panel-new, #login-full-panel, #douyin-login-new-id, [role="dialog"], .semi-modal')).filter(el => {
          const r = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        });
        const text = surfaces.map(el => el.innerText || '').join('\n');
        const expired = /二维码(?:已)?(?:失效|过期)|点击刷新/.test(text);
        const challenged = /安全验证|访问过于频繁|操作频繁|请完成验证|请进行验证|扫码成功|扫描成功|已扫码|请在手机.{0,12}确认|手机.{0,12}确认登录/.test(text) || (text.includes('身份验证') && text.includes('接收短信验证码'));
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
          challenged,
          qrDataUrl: qrImg ? qrImg.getAttribute('src') : '',
          canvasCount: canvases.length,
        };
      });

      if (state.expired || state.challenged) {
        console.log('[DouyinDaemon] 警告：页面当前为失效蒙层，拒绝保存废码！');
        return false;
      }

      // 二维码本身就是 base64 图片，直接落盘，比按坐标截图更清晰也不会截错区域
      if (state.qrDataUrl && state.qrDataUrl.includes(',')) {
        const b64 = state.qrDataUrl.split(',')[1];
        fs.writeFileSync(QR_SCRATCH, Buffer.from(b64, 'base64'));
        // Image already resides in the private scratch directory.
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
          // Image already resides in the private scratch directory.
          console.log('[DouyinDaemon] ✅ 已截取二维码画布');
          return true;
        }
      }

      console.log('[DouyinDaemon] 未找到二维码元素（弹窗可能没打开）');
      return false;
    } catch (e) {
      console.error('[DouyinDaemon] 截取异常');
      return false;
    }
  }

  async function saveModalShot() {
    // Verification dialogs may contain personal information; never capture them.
    try { fs.unlinkSync(QR_SCRATCH); } catch {}
  }

  async function reloadFreshQR() {
    console.log('[DouyinDaemon] 触发完整页面重载获取绝对新鲜二维码...');
    try {
      try { fs.unlinkSync(QR_SCRATCH); } catch {}
      writeStatus({ status: 'refreshing', msg: '正在重新生成最新二维码...' });
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);
      await openLoginModal();
      await page.waitForTimeout(8000);
      const ok = await saveQRShot();
      if (ok) {
        writeStatus({ status: 'ready', msg: '二维码已就绪，会话持续保持中，请扫码！' });
      } else {
        writeStatus({ status: 'waiting_modal', msg: '页面已刷新，请在当前会话中继续登录。' });
      }
    } catch (e) {
      console.error('[DouyinDaemon] 重载异常');
      if (!signal?.aborted) writeStatus({ status: 'error', msg: '刷新失败，请重新开始登录。' });
      throw e;
    }
  }

  writeStatus({ status: 'navigating', msg: '正在打开抖音精选...' });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(delays.initial ?? 3000);

  await openLoginModal();
  console.log('[DouyinDaemon] 等待二维码生成...');
  await page.waitForTimeout(delays.qr ?? 9000);

  const ok = await saveQRShot();
  writeStatus(
    ok
      ? { status: 'ready', msg: '二维码已就绪，请使用抖音 App 扫一扫！' }
      : { status: 'waiting_modal', msg: '正在等待登录弹窗出现…' }
  );

  const startTime = Date.now();
  let lastRefresh = Date.now();
  let challengePending = false;
  let confirmationPending = false;
  let observationErrors = 0;

  while (!signal?.aborted && Date.now() - startTime < 1800000) {
    await page.waitForTimeout(delays.poll ?? 1500);

    // 1. 检查是否登录成功 (必须真实 sessionid)
    let cookies = [];
    try { cookies = await context.cookies(); } catch {}
    const hasSession = cookies.some(c => c.name === 'sessionid' && c.value && c.value.length > 5);

    let isModalGone = false;
    let pageState = null;

    try {
      isModalGone = await page.evaluate(() => {
        return !Array.from(document.querySelectorAll('#login-panel-new, #login-full-panel, #douyin-login-new-id, [role="dialog"], .semi-modal')).some(el => {
          const r=el.getBoundingClientRect(), style=getComputedStyle(el);
          return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        });
      });

      pageState = await page.evaluate(() => {
        // Restrict challenge detection to visible login/dialog surfaces; the feed
        // can contain arbitrary video titles including security-verification text.
        const surfaces = Array.from(document.querySelectorAll('#login-panel-new, #login-full-panel, #douyin-login-new-id, [role="dialog"], .semi-modal')).filter(el => {
          const r = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        });
        const text = surfaces.map(el => el.innerText || '').join('\n');
        const hasChooseVerify = text.includes('身份验证') && text.includes('接收短信验证码') && !text.includes('短信已发送');
        const hasInputSms = text.includes('接收短信验证码') && (text.includes('短信已发送') || text.includes('重新发送') || surfaces.some(el => el.querySelector('input[placeholder*="验证码"]')));
        // “验证码登录” is normal login UI, not a challenge by itself.
        const risk = /安全验证|访问过于频繁|操作频繁|请完成验证|请进行验证/.test(text);
        const isQrScreen = text.includes('扫码登录') || surfaces.some(el => el.querySelector('canvas'));
        const isExpired = /二维码(?:已)?(?:失效|过期)|点击刷新/.test(text);
        const confirmation = /扫码成功|扫描成功|已扫码|请在手机.{0,12}确认|手机.{0,12}确认登录/.test(text);
        return { hasChooseVerify, hasInputSms, risk, isQrScreen, isExpired, confirmation };
      });
    } catch {
      diagnostic('browser_error');
      if (++observationErrors >= 3) throw new Error('Page observation unavailable');
      continue;
    }
    observationErrors = 0;
    if (pageState.confirmation) confirmationPending = true;
    const action = decideQrAction({...pageState, hasSession, modalGone:isModalGone, challengePending,
      confirmation:confirmationPending && !pageState.isExpired,
      refreshDue:Date.now()-lastRefresh > 60000, reopenDue:Date.now()-lastRefresh > 20000});
    if (pageState.isExpired) confirmationPending = false;

    // A risk challenge always takes precedence over the mere presence of a cookie.
    if (action === 'challenge') {
      challengePending = true;
      await saveModalShot();
      writeStatus({ status: 'need_sms', msg: '等待本人在官方应用中完成验证；当前网页无法提供安全交互。' });
      continue;
    }
    if (action === 'candidate') {
      // Candidate only. The parent independently verifies and atomically promotes it.
      fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies), {encoding:'utf8',mode:0o600,flag:'wx'});
      try { fs.unlinkSync(QR_SCRATCH); } catch {}
      writeStatus({ status: 'success' });
      break;
    }

    // Never reload or click the page once a challenge has been observed.
    if (challengePending) continue;
    if (action === 'confirm') {
      await saveModalShot();
      writeStatus({status:'confirm', msg:'已扫码，请在官方应用中确认。'});
      continue;
    }

    // Refresh only on explicit expiry or an unscanned QR timeout.
    if (action === 'refresh') {
      console.log('[DouyinDaemon] 二维码已超时或失效，开始重新获取...');
      await reloadFreshQR();
      lastRefresh = Date.now();
    } else if (action === 'reopen') {
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

  if (Date.now() - startTime >= 1800000) writeStatus({status:'expired'});
  } catch (e) {
    if (!signal?.aborted) {
      writeStatus({status:'error'});
      throw e;
    }
  } finally {
    try { fs.unlinkSync(QR_SCRATCH); } catch {}
    await browser?.close().catch(()=>{});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startDaemon().catch(() => { process.exitCode = 1; });
}
