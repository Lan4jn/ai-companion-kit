// SYNTHETIC FIXTURE ONLY. No real platform, credentials or network access.
// This is not an implementation of production authentication.
import { chromium } from 'playwright-core';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const ORIGIN = 'https://fixture.invalid';
const LOGIN = `${ORIGIN}/login`;
const FORUM = `${ORIGIN}/forum`;
const htmlLogin = `<!doctype html><button>Synthetic sign in</button><script>
document.querySelector('button').onclick=async()=>{await fetch('/synthetic-sign-in',{method:'POST'});document.body.insertAdjacentHTML('beforeend','<p>Synthetic session ready</p>')};
</script>`;

export async function createSyntheticTiebaSession({ root }) {
  const profile = join(root, 'profile');
  await mkdir(profile, { mode: 0o700 });
  await chmod(profile, 0o700);
  let context;
  try { context = await chromium.launchPersistentContext(profile, {
    executablePath: '/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome',
    headless: true, serviceWorkers: 'block',
    proxy: { server: 'http://synthetic-block.invalid:9', bypass: '<-loopback>' },
    args: ['--no-sandbox', '--disable-background-networking', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--host-resolver-rules=MAP * ~NOTFOUND'],
  }); } catch (error) { await rm(profile, { recursive: true, force: true }); throw error; }
  let signedIn = false;
  try {
    if (!context.routeWebSocket) throw new Error('synthetic_websocket_guard_unavailable');
    await context.routeWebSocket('**/*', ws => ws.close());
    await context.route('**/*', async route => {
      const req = route.request();
      if (req.url() === LOGIN && req.method() === 'GET') return route.fulfill({ status: 200, contentType: 'text/html', body: htmlLogin });
      if (req.url() === `${ORIGIN}/synthetic-sign-in` && req.method() === 'POST' && !signedIn) {
        signedIn = true;
        return route.fulfill({ status: 200, headers: { 'set-cookie': 'synthetic_fixture=ready; Path=/; Secure; HttpOnly; SameSite=Strict' }, body: 'ok' });
      }
      if (req.url() === FORUM && req.method() === 'GET') {
        const ok = (await req.allHeaders()).cookie?.split('; ').includes('synthetic_fixture=ready');
        return route.fulfill({ status: ok ? 200 : 401, contentType: 'text/html', body: ok ? '<p>Synthetic forum content</p>' : '<p>Synthetic login required</p>' });
      }
      return route.abort();
    });
    const loginPage = await context.newPage();
    await loginPage.goto(LOGIN);
    return {
      loginPage,
      async navigate(url) {
        if (url !== FORUM) throw new Error('synthetic_navigation_denied');
        const page = await context.newPage();
        try {
          const response = await page.goto(url);
          if (!response || response.status() !== 200) throw new Error('synthetic_not_authenticated');
          return await page.locator('p').innerText();
        } finally { await page.close(); }
      },
      async read() { return this.navigate(FORUM); },
      async close() { try { await context.close(); } finally { await rm(profile, { recursive: true, force: true }); } },
    };
  } catch (e) { try { await context.close(); } finally { await rm(profile, { recursive: true, force: true }); } throw e; }
}
