// Offline fixture only: never accepts real domains, credentials, or network.
// This module is deliberately not wired into the production login or reader.
import { chromium } from 'playwright-core';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ORIGIN = 'https://fixture.invalid';
const EXECUTABLE = '/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome';
const fixtureCandidates = new WeakSet();
const FIXTURE_URL = 'https://tieba.baidu.com/p/123';

// Only for testing the real reader's adapter contract; the URL is a synthetic
// identifier, never fetched. This must not be wired to production.
export function createFixtureReaderSource(candidate) {
  if (!fixtureCandidates.has(candidate)) throw new Error('fixture_invalid_candidate');
  return {
    async list({ forum, signal } = {}) {
      if (forum !== '肥鱼避难所吧' || signal?.aborted) throw new Error('fixture_invalid_request');
      await candidate.read();
      if (signal?.aborted) throw new Error('fixture_cancelled');
      return [{ url: FIXTURE_URL }];
    },
    async read({ forum, url, signal } = {}) {
      if (forum !== '肥鱼避难所吧' || url !== FIXTURE_URL || signal?.aborted) throw new Error('fixture_invalid_request');
      const body = await candidate.read();
      if (signal?.aborted) throw new Error('fixture_cancelled');
      return { url, forum, title: 'fixture post', body };
    },
  };
}

export async function createTiebaCandidate() {
  throw new Error('tieba_candidate_disabled_unverified_security');
}

export async function createFixtureCandidate({ root, ttlMs = 30000, rejectIdentity = false } = {}) {
  if (!root || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 300000) throw new Error('fixture_invalid_options');
  const browser = await chromium.launch({ executablePath: EXECUTABLE, headless: true,
    proxy: { server: 'http://fixture-block.invalid:9', bypass: '<-loopback>' },
    args: ['--no-sandbox', '--disable-background-networking', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--host-resolver-rules=MAP * ~NOTFOUND'] });
  let context, dir, closed = false, authenticated = false, timer;
  async function close() {
    if (closed) return;
    closed = true; authenticated = false; clearTimeout(timer);
    await context?.close().catch(() => {});
    await browser.close().catch(() => {});
    if (dir) await rm(dir, { recursive: true, force: true });
  }
  try {
    context = await browser.newContext({ serviceWorkers: 'block' });
    if (!context.routeWebSocket) throw new Error('fixture_websocket_guard_unavailable');
    await context.routeWebSocket('**/*', ws => ws.close());
    await context.route('**/*', async route => {
      const req = route.request();
      try {
        if (req.url() === `${ORIGIN}/login` && req.method() === 'GET') return await route.fulfill({ status: 200, contentType: 'text/html', body: '<button>fixture sign in</button><script>document.querySelector("button").onclick=()=>fetch("/sign-in",{method:"POST"})</script>' });
        if (req.url() === `${ORIGIN}/sign-in` && req.method() === 'POST') return await route.fulfill({ status: 200, headers: { 'set-cookie': 'fixture_session=ready; Path=/; Secure; HttpOnly; SameSite=Strict' }, body: 'ok' });
        if (req.url() === `${ORIGIN}/identity` && req.method() === 'GET') {
          const ok = !rejectIdentity && (await req.allHeaders()).cookie?.split(/;\s*/).includes('fixture_session=ready');
          return await route.fulfill({ status: ok ? 200 : 401, contentType: 'application/json', body: JSON.stringify({ fixture: true, authenticated: !!ok }) });
        }
        if (req.url() === `${ORIGIN}/forum` && req.method() === 'GET') {
          const ok = (await req.allHeaders()).cookie?.split(/;\s*/).includes('fixture_session=ready');
          return await route.fulfill({ status: ok ? 200 : 401, contentType: 'text/plain', body: ok ? 'fixture forum content' : 'login required' });
        }
        await route.abort();
      } catch { await route.abort().catch(() => {}); }
    });
    timer = setTimeout(() => { void close(); }, ttlMs); timer.unref();
    const candidate = {
      async login() {
        if (closed) throw new Error('fixture_closed');
        if (authenticated) throw new Error('fixture_already_authenticated');
        try {
          const page = await context.newPage();
          await page.goto(`${ORIGIN}/login`);
          const signedIn = page.waitForResponse(r => r.url() === `${ORIGIN}/sign-in` && r.request().method() === 'POST' && r.status() === 200);
          await page.click('button'); await signedIn;
          const identity = await page.goto(`${ORIGIN}/identity`);
          const evidence = await identity.json();
          if (identity.status() !== 200 || evidence.fixture !== true || evidence.authenticated !== true) throw new Error('fixture_identity_failed');
          if (closed) throw new Error('fixture_closed');
          dir = await mkdtemp(join(root, 'fixture-'));
          await chmod(dir, 0o700);
          const state = await context.storageState();
          await writeFile(join(dir, 'state.json'), JSON.stringify(state), { mode: 0o600, flag: 'wx' });
          if (closed) { await rm(dir, { recursive: true, force: true }); throw new Error('fixture_closed'); }
          authenticated = true;
          await page.close();
        } catch (error) { await close(); throw error; }
      },
      async read() {
        if (closed) throw new Error('fixture_closed');
        if (!authenticated) throw new Error('fixture_not_authenticated');
        const page = await context.newPage();
        try {
          const response = await page.goto(`${ORIGIN}/forum`);
          if (response.status() !== 200 || page.url() !== `${ORIGIN}/forum`) throw new Error('fixture_read_failed');
          return await page.locator('body').innerText();
        } finally { await page.close().catch(() => {}); }
      },
      close,
    };
    fixtureCandidates.add(candidate);
    return candidate;
  } catch (error) { await close(); throw error; }
}
