// Synthetic-only handoff: no real domains, credentials, or production wiring.
import { chromium } from 'playwright-core';
import { createHeadedDisplay } from './douyin-headed-display.js';
import { createHandoffBridge } from './douyin-handoff-bridge.js';

const ORIGIN = 'https://fixture.invalid';
const POST = 'https://tieba.baidu.com/p/123'; // reader identifier only; never fetched
const CHROME = '/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome';

export function createTiebaMockHandoff({ enabled = false, accessToken, root, ttlMs = 180000, readyMs = 15000 } = {}) {
  if (!enabled) return { handle: () => false, upgrade: () => false, close: async () => {}, source: null, status: () => 'unknown' };
  if (!root?.startsWith('/')) throw Error('fixture_invalid_root');
  let active = null, generation = 0, closed = false;
  async function stop() {
    generation++;
    const s = active; active = null;
    if (!s) return;
    s.lifetime.abort();
    await s.context?.close().catch(() => {});
    await s.browser?.close().catch(() => {});
    await s.display?.close().catch(() => {});
  }
  async function boot(s, id) {
    try {
      s.display = await createHeadedDisplay({ root, ttlMs });
      if (id !== generation || closed) throw Error('cancelled');
      s.browser = await chromium.launch({ executablePath: CHROME, headless: false,
        env: { ...process.env, ...s.display.env, HOME: root },
        proxy: { server: 'http://fixture-block.invalid:9', bypass: '<-loopback>' },
        args: ['--no-sandbox', '--disable-background-networking', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--host-resolver-rules=MAP * ~NOTFOUND'] });
      if (id !== generation || closed) throw Error('cancelled');
      s.context = await s.browser.newContext({ serviceWorkers: 'block' });
      if (!s.context.routeWebSocket) throw Error('no websocket guard');
      await s.context.routeWebSocket('**/*', ws => ws.close());
      await s.context.route('**/*', async route => {
        const req = route.request();
        try {
          if (req.url() === `${ORIGIN}/login` && req.method() === 'GET') return await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><style>html,body,button{width:100%;height:100%;margin:0}</style><button>模拟登录（不输入真实账号）</button><script>document.querySelector("button").onclick=e=>{if(e.isTrusted)fetch("/sign-in",{method:"POST"}).then(()=>document.body.textContent="模拟登录完成")}</script>' });
          if (req.url() === `${ORIGIN}/sign-in` && req.method() === 'POST' && !s.readOnly && !s.signInUsed) { s.signInUsed = true; const result = await route.fulfill({ status: 200, headers: { 'set-cookie': 'fixture_session=ready; Path=/; Secure; HttpOnly; SameSite=Strict' }, body: 'ok' }); s.complete(); return result; }
          if ([`${ORIGIN}/identity`, `${ORIGIN}/forum`].includes(req.url()) && req.method() === 'GET') {
            const ok = (await req.allHeaders()).cookie?.split(/;\s*/).includes('fixture_session=ready');
            if (req.url().endsWith('/identity')) return await route.fulfill({ status: ok ? 200 : 401, contentType: 'application/json', body: JSON.stringify({ fixture: true, authenticated: !!ok }) });
            return await route.fulfill({ status: ok ? 200 : 401, contentType: 'text/html; charset=utf-8', body: ok ? '<div class="forum-name-main">肥鱼避难所</div><div class="forum-name-suffix">吧</div><div class="center-content"><div class="image-text"><div class="pb-title">fixture post</div><div class="pb-content-wrap"><div tid="123">fixture forum content</div></div><div class="desc-info"><span class="post-num">2026-01-01</span></div></div></div>' : 'login required' });
          }
          await route.abort();
        } catch { await route.abort().catch(() => {}); }
      });
      s.page = await s.context.newPage();
      await s.page.goto(`${ORIGIN}/login`);
      if (id !== generation || closed) throw Error('cancelled');
      s.ready = true;
      void s.display.closed.then(() => { if (active === s) void stop(); });
    } catch { if (active === s) await stop(); else { await s.context?.close().catch(() => {}); await s.browser?.close().catch(() => {}); await s.display?.close().catch(() => {}); } }
  }
  const service = {
    startHeadedDouyin() { if (closed || active) return { state: 'unknown' }; const s = { lifetime: new AbortController() }; s.completion = new Promise(resolve => { s.complete = resolve; }); active = s; void boot(s, ++generation); return { state: 'starting' }; },
    headedDouyinDisplay() { return active?.ready ? active.display : null; },
    disconnectHeadedDouyin: stop, cancelHeadedDouyin: stop,
  };
  const bridge = createHandoffBridge({ enabled: true, accessToken, service, ttlMs, readyMs });
  async function readFixture(path) {
    const s = active;
    if (!s?.ready) throw Error('fixture_unavailable');
    const page = await s.context.newPage();
    try {
      const response = await page.goto(`${ORIGIN}/${path}`);
      if (active !== s || response.status() !== 200) throw Error('fixture_unavailable');
      if (path === 'identity') { const data = await response.json(); if (!data.fixture || !data.authenticated) throw Error('fixture_unavailable'); return; }
      return await page.locator('body').innerText();
    } finally { await page.close().catch(() => {}); }
  }
  const source = Object.freeze({
    async list({ forum, signal } = {}) { if (forum !== '肥鱼避难所吧' || signal?.aborted) throw Error('fixture_unavailable'); await readFixture('identity'); if (signal?.aborted) throw Error('fixture_unavailable'); return [{ url: POST }]; },
    async read({ forum, url, signal } = {}) { if (forum !== '肥鱼避难所吧' || url !== POST || signal?.aborted) throw Error('fixture_unavailable'); await readFixture('identity'); const body = await readFixture('forum'); if (signal?.aborted) throw Error('fixture_unavailable'); return { url, forum, title: 'fixture post', body }; },
  });
  // Reuse the authenticated viewer without describing this mock as Douyin.
  function handle(req, res) {
    if (req.url === '/handoff' && req.method === 'GET') {
      const end = res.end;
      res.end = function (body, ...args) {
        if (typeof body === 'string') body = body.replace('抖音登录接管', '贴吧模拟登录接管').replace('独立接管会话：与已有扫码会话不同。关闭页面即取消；仅可信局域网明文使用。', '仅限模拟登录，禁止输入真实账号或密码。关闭页面即取消；仅可信局域网明文使用。');
        return end.call(this, body, ...args);
      };
    }
    return bridge.handle(req, res);
  }
  function fixtureDependencies() {
    return {
      openOwnerSession: async () => {
        const s = active;
        if (!s?.ready) throw Error('fixture_unavailable');
        return { context: s.context, signal: s.lifetime.signal, waitForCompletion: () => s.completion, isActive: () => active === s && s.ready === true, close: async () => { if (active === s) await stop(); } };
      },
      verifyIdentity: async context => {
        try { const s = active; if (!s?.ready || context !== s.context) return { state: 'unknown' }; await readFixture('identity'); if (active !== s) return { state: 'unknown' }; s.readOnly = true; return { state: 'online', subject: 'synthetic-fixture-account' }; } catch { return { state: 'unknown' }; }
      },
      // Test-only adversarial probes run in the exact same browser context.
      probeReadBoundary: async localUrl => {
        const s = active;
        if (!s?.ready || !s.readOnly) throw Error('fixture_unavailable');
        const page = await s.context.newPage();
        try {
          await page.goto(`${ORIGIN}/login`);
          return await page.evaluate(async localUrl => {
            const blocked = async (url, options) => { try { await fetch(url, options); return false; } catch { return true; } };
            const repeatSignInBlocked = await blocked('/sign-in', { method: 'POST' });
            const localBlocked = await blocked(localUrl);
            const websocketBlocked = await new Promise(resolve => {
              const ws = new WebSocket('wss://fixture.invalid/socket');
              const timer = setTimeout(() => { ws.close(); resolve(false); }, 2000);
              ws.onopen = () => { clearTimeout(timer); ws.close(); resolve(false); };
              ws.onerror = () => { clearTimeout(timer); resolve(true); };
              ws.onclose = () => { clearTimeout(timer); resolve(true); };
            });
            return { repeatSignInBlocked, localBlocked, websocketBlocked };
          }, localUrl);
        } finally { await page.close().catch(() => {}); }
      },
      listSource: { list: async ({ forum, signal } = {}) => { if (forum !== '肥鱼避难所吧' || signal?.aborted) throw Error('fixture_unavailable'); await readFixture('identity'); return [{ url: POST }]; } },
      // Fixture-only same-context transport. Browser routing above blocks all
      // real network; this is not an official Baidu egress policy.
      createTransport: context => {
        if (!active?.ready || active.context !== context) throw Error('fixture_unavailable');
        const s = active, pages = new Set(); let closed = false;
        return {
          async fetchBody(url, { signal, method = 'GET' } = {}) {
            if (closed || active !== s || url !== POST || method !== 'GET' || signal?.aborted) throw Error('fixture_unavailable');
            const page = await context.newPage(); pages.add(page);
            const cancel = () => { void page.close().catch(() => {}); };
            signal?.addEventListener('abort', cancel, { once: true });
            try {
              if (closed || active !== s || signal?.aborted) throw Error('fixture_unavailable');
              const response = await page.goto(`${ORIGIN}/forum`);
              const body = await page.content();
              if (closed || signal?.aborted || active !== s || response?.status() !== 200) throw Error('fixture_unavailable');
              return { status: 200, body: Buffer.from(body), html: body };
            } finally { signal?.removeEventListener('abort', cancel); pages.delete(page); await page.close().catch(() => {}); }
          },
          async close() { closed = true; await Promise.all([...pages].map(page => page.close().catch(() => {}))); },
        };
      },
      executablePath: CHROME,
    };
  }
  return { handle, upgrade: bridge.upgrade, source, fixtureDependencies, status: () => 'unknown', async close() { closed = true; await bridge.close(); await stop(); } };
}
