import { Resolver } from 'node:dns/promises';
import https from 'node:https';
import { isPublicIPv4, isPublicIPv6, extractThreadDOM } from './tieba-playwright.js';

// Experimental, disconnected helpers. No production wiring or identity claim.
// Production enablement needs a verified official identity protocol and a
// trusted, isolated session handoff; neither is established by cookie presence.
export function createTrustedTiebaBridge() {
  throw new Error('tieba_trusted_bridge_unavailable');
}

export function cookieHeaderForTieba(url, cookies, now = Date.now()) {
  let target;
  try { target = new URL(url); } catch { return ''; }
  if (target.protocol !== 'https:' || target.host !== 'tieba.baidu.com' || target.username || target.password || !Array.isArray(cookies)) return '';
  return cookies.filter(cookie => {
    if (!cookie || cookie.domain !== 'tieba.baidu.com' || cookie.secure !== true || typeof cookie.name !== 'string' || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(cookie.name) || typeof cookie.value !== 'string' || !/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/.test(cookie.value)) return false;
    if (cookie.expires !== undefined && cookie.expires !== -1 && (!Number.isFinite(cookie.expires) || cookie.expires * 1000 <= now)) return false;
    const path = cookie.path;
    if (typeof path !== 'string' || !path.startsWith('/')) return false;
    return target.pathname === path || (target.pathname.startsWith(path) && (path.endsWith('/') || target.pathname[path.length] === '/'));
  }).map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
}

// Isolated prototype only: context must be an owner-controlled browser context,
// never request JSON or model input. No bridge to the reader is installed.
// Dependency injection is for offline simulations; not a production interface.
export function createTiebaReadOnlyCandidate({ context, resolve4, resolve6, request, timeoutMs = 10000 } = {}) {
  if (!context || typeof context.cookies !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('tieba_invalid_candidate');
  const resolver = new Resolver();
  const lookup4 = resolve4 || (host => resolver.resolve4(host));
  const lookup6 = resolve6 || (host => resolver.resolve6(host));
  let closed = false;
  const pending = new Set();
  async function fetchBody(url, { method = 'GET', signal } = {}) {
    if (closed) throw new Error('tieba_candidate_closed');
    if (signal?.aborted) throw new Error('tieba_candidate_cancelled');
    if (method !== 'GET' || typeof url !== 'string' || !/^https:\/\/tieba\.baidu\.com\/p\/[0-9]+$(?![\s\S])/.test(url)) throw new Error('tieba_candidate_request_blocked');
    const controller = new AbortController();
    pending.add(controller);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { resolver.cancel(); controller.abort(); }, timeoutMs);
    const cancelled = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('tieba_candidate_cancelled')), { once: true }));
    try {
      const dns = async (lookup) => {
        try { return await lookup('tieba.baidu.com'); }
        catch (error) { if (['ENODATA', 'ENOTFOUND'].includes(error?.code)) return []; throw new Error('tieba_unsafe_dns'); }
      };
      const [v4, v6] = await Promise.race([Promise.all([dns(lookup4), dns(lookup6)]), cancelled]);
      if (!Array.isArray(v4) || !Array.isArray(v6) || (!v4.length && !v6.length) || v4.some(ip => !isPublicIPv4(ip)) || v6.some(ip => !isPublicIPv6(ip))) throw new Error('tieba_unsafe_dns');
      const ip = v4[0] || v6[0], family = v4.length ? 4 : 6;
      const cookies = await Promise.race([context.cookies(url), cancelled]);
      const cookie = cookieHeaderForTieba(url, cookies);
      const headers = { accept: 'text/html', 'accept-encoding': 'identity', ...(cookie ? { cookie } : {}) };
      const response = await Promise.race([(request || pinnedRequest)({ url, ip, family, headers, signal: controller.signal }), cancelled]);
      if (!response || response.status !== 200 || !Buffer.isBuffer(response.body)) throw new Error('tieba_candidate_response_blocked');
      // Reject redirect hints, partial content and unsupported encodings even in
      // injected test transports; normalize header case defensively.
      if (response.headers != null) {
        if (typeof response.headers !== 'object' || Array.isArray(response.headers)) throw new Error('tieba_candidate_response_blocked');
        for (const [key, value] of Object.entries(response.headers)) {
          const name = key.toLowerCase();
          if (name === 'location' || name === 'content-range' || (name === 'content-encoding' && (typeof value !== 'string' || value.toLowerCase().trim() !== 'identity'))) throw new Error('tieba_candidate_response_blocked');
        }
      }
      if (response.body.length > 8 * 1024 * 1024) throw new Error('tieba_candidate_response_too_large');
      const html = response.body.toString('utf8');
      // Never forward a response that directly reflects a sent credential.
      const secrets = cookie.split('; ').map(pair => pair.slice(pair.indexOf('=') + 1)).filter(value => value.length >= 4);
      if (secrets.some(value => html.includes(value))) throw new Error('tieba_candidate_response_blocked');
      return { status: response.status, bytes: response.body.length, identity: 'unknown', html };
    } catch (error) {
      if (['tieba_unsafe_dns', 'tieba_candidate_cancelled', 'tieba_candidate_response_blocked', 'tieba_candidate_response_too_large', 'tieba_candidate_response_aborted'].includes(error?.message)) throw new Error(error.message);
      throw new Error('tieba_candidate_failed');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); pending.delete(controller); }
  }
  async function read(url, options) {
    const { html, ...status } = await fetchBody(url, options);
    return status;
  }
  async function close() {
    if (closed) return;
    closed = true;
    resolver.cancel();
    for (const controller of pending) controller.abort();
    pending.clear();
    context = null;
  }
  return Object.freeze({ read, fetchBody, close });
}

// Explicitly opt-in experimental adapter; production remains anonymous until a
// trusted session handoff and authoritative identity protocol are available.
export function createTiebaCandidateSource({ transport, listSource, chromium, executablePath } = {}) {
  if (typeof transport?.fetchBody !== 'function' || typeof transport?.close !== 'function' || typeof listSource?.list !== 'function') throw new Error('tieba_invalid_source');
  let closed = false;
  const browsers = new Set();
  return Object.freeze({
    async list(options = {}) {
      if (closed) throw new Error('tieba_candidate_closed');
      if (options.forum !== '肥鱼避难所吧') throw new Error('tieba_forum_not_allowed');
      return listSource.list(options);
    },
    async read({ url, forum, signal } = {}) {
      if (closed) throw new Error('tieba_candidate_closed');
      if (forum !== '肥鱼避难所吧' || typeof url !== 'string' || !/^https:\/\/tieba\.baidu\.com\/p\/[0-9]+$(?![\s\S])/.test(url)) throw new Error('tieba_thread_not_allowed');
      const response = await transport.fetchBody(url, { signal });
      if (closed || signal?.aborted) throw new Error('tieba_candidate_cancelled');
      let browser;
      const abort = () => { void browser?.close().catch(() => {}); };
      try {
        const engine = chromium || (await import('playwright-core')).chromium;
        browser = await engine.launch({ headless: true, ...(executablePath ? { executablePath } : {}), proxy: { server: 'http://tieba-block.invalid:9', bypass: '<-loopback>' }, args: ['--no-sandbox', '--disable-background-networking', '--disable-quic', '--host-resolver-rules=MAP * ~NOTFOUND'] });
        browsers.add(browser);
        signal?.addEventListener('abort', abort, { once: true });
        if (closed || signal?.aborted) throw new Error('tieba_candidate_cancelled');
        const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block' });
        await context.route('**/*', route => route.abort());
        const page = await context.newPage();
        await page.setContent(response.html, { waitUntil: 'load' });
        const data = await page.evaluate(extractThreadDOM);
        const id = url.slice(url.lastIndexOf('/') + 1);
        if (closed || signal?.aborted) throw new Error('tieba_candidate_cancelled');
        if (data.forum !== forum || data.id !== id || !data.title || !data.body || !data.time || data.truncated || data.title.length > 500 || data.body.length > 20000) throw new Error('tieba_incomplete_thread');
        return { url, forum, id, title: data.title, body: data.body, time: data.time, identity: 'unknown' };
      } catch (error) {
        if (['tieba_candidate_cancelled', 'tieba_incomplete_thread'].includes(error?.message)) throw new Error(error.message);
        throw new Error('tieba_candidate_parse_failed');
      } finally {
        signal?.removeEventListener('abort', abort);
        if (browser) { browsers.delete(browser); await browser.close().catch(() => {}); }
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all([transport.close(), ...[...browsers].map(browser => browser.close().catch(() => {}))]);
    },
  });
}

function pinnedRequest({ url, ip, family, headers, signal }) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'GET', headers, agent: false, family, autoSelectFamily: false, signal, lookup: (_host, opts, cb) => opts.all ? cb(null, [{ address: ip, family }]) : cb(null, ip, family) }, res => {
      if (res.statusCode !== 200) { res.destroy(); reject(new Error('tieba_candidate_response_blocked')); return; }
      let size = 0; const chunks = [];
      res.on('data', chunk => { size += chunk.length; if (size > 8 * 1024 * 1024) res.destroy(new Error('tieba_candidate_response_too_large')); else chunks.push(chunk); });
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('tieba_candidate_response_aborted')));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}
