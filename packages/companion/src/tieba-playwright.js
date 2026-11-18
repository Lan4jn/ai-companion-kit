import { resolve4, resolve6, Resolver } from 'node:dns/promises';
import https from 'node:https';
import { isIPv4, isIPv6 } from 'node:net';

// Anonymous, isolated, read-only Tieba source. Never attach to an existing browser.
const FORUM = '肥鱼避难所吧';
const LIST_URL = 'https://tieba.baidu.com/f?kw=%E8%82%A5%E9%B1%BC%E9%81%BF%E9%9A%BE%E6%89%80';
const STATIC_HOSTS = new Set(['tb3.bdstatic.com']);
const DATA_PATHS = new Set(['/c/f/frs/page_pc', '/c/f/pb/page_pc', '/c/f/frs/frsBottom_pc']);

// Conservative IPv4-only policy: reject every special-purpose range, including
// documentation, multicast and benchmarking blocks.
export function isPublicIPv4(ip) {
  if (!isIPv4(ip)) return false;
  const [a,b,c] = ip.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113));
}
export async function resolvePublicIPv4(host, resolver = resolve4) {
  const ips = await resolver(host);
  if (!Array.isArray(ips) || !ips.length || ips.some(ip => !isPublicIPv4(ip))) throw new Error('tieba_unsafe_dns');
  return ips[0];
}

// APNIC's global unicast 2400::/12 only; this intentionally excludes other
// IPv6 address space, including mapped, transition and special-purpose ranges.
export function isPublicIPv6(ip) {
  if (!isIPv6(ip) || ip.includes('%')) return false;
  const first = parseInt(ip.split(':')[0], 16);
  return first >= 0x2400 && first <= 0x240f;
}
export async function resolvePublicIPv6(host, resolver = resolve6) {
  const ips = await resolver(host);
  if (!Array.isArray(ips) || !ips.length || ips.some(ip => !isPublicIPv6(ip))) throw new Error('tieba_unsafe_dns');
  return ips[0];
}

// Do not use route.fetch(): its automatic redirects and DNS happen outside our
// control. Every browser request is fulfilled using this pinned TLS connection.
export async function fetchPinned(request, timeoutMs, signal, resolver) {
  if (signal?.aborted) throw signal.reason || new Error('cancelled');
  const deadline = new AbortController();
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const dnsResolver = resolver ? null : new Resolver();
  const timer = setTimeout(() => deadline.abort(new Error('tieba_network_timeout')), timeoutMs);
  let onAbort;
  const interrupted = new Promise((_, reject) => {
    onAbort = () => { dnsResolver?.cancel(); reject(combined.reason || new Error('cancelled')); };
    if (combined.aborted) onAbort();
    else combined.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await fetchPinnedInner(request, timeoutMs, combined, resolver, dnsResolver, interrupted);
  } finally {
    clearTimeout(timer);
    combined.removeEventListener('abort', onAbort);
  }
}

async function fetchPinnedInner(request, timeoutMs, signal, resolver, dnsResolver, interrupted) {
  const url = new URL(request.url());
  let ip, family;
  if (resolver) { ip = await Promise.race([resolvePublicIPv4(url.hostname, resolver), interrupted]); family = 4; }
  else {
    try { ip = await Promise.race([resolvePublicIPv6(url.hostname, host => dnsResolver.resolve6(host)), interrupted]); family = 6; }
    catch (error) {
      // Unsafe DNS and cancellation are not reasons to fall back; missing AAAA is.
      if (signal.aborted || !['ENODATA', 'ENOTFOUND'].includes(error.code)) throw error;
      ip = await Promise.race([resolvePublicIPv4(url.hostname, host => dnsResolver.resolve4(host)), interrupted]); family = 4;
    }
  }
  if (signal?.aborted) throw new Error('cancelled');
  const method = request.method();
  const body = method === 'POST' ? request.postDataBuffer() : null;
  if (body && body.length > 16384) throw new Error('tieba_request_too_large');
  const headers = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', 'accept': '*/*', 'accept-language': 'zh-CN,zh;q=0.9', 'accept-encoding': 'identity' };
  if (body) { headers['content-type'] = 'application/x-www-form-urlencoded'; headers['content-length'] = String(body.length); }
  return await new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers, agent: false, family, autoSelectFamily: false, lookup: (_host, opts, cb) => opts.all ? cb(null, [{ address: ip, family }]) : cb(null, ip, family), signal, timeout: timeoutMs }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400) { res.destroy(); reject(new Error('tieba_redirect_blocked')); return; }
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 8 * 1024 * 1024) res.destroy(new Error('tieba_response_too_large')); else chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => {
        const safeHeaders = {};
        for (const [name, value] of Object.entries(res.headers)) if (value != null && !['set-cookie','content-length','transfer-encoding','connection','content-security-policy-report-only','report-to','nel','alt-svc'].includes(name)) safeHeaders[name] = Array.isArray(value) ? value.join(', ') : value;
        resolve({ status: res.statusCode, headers: safeHeaders, body: Buffer.concat(chunks) });
      });
    });
    req.on('timeout', () => req.destroy(new Error('tieba_network_timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

export function validateThreadUrl(value) {
  return typeof value === 'string' && /^https:\/\/tieba\.baidu\.com\/p\/[0-9]+$/.test(value);
}
export function extractForumDOM() {
  const text = selector => document.querySelector(selector)?.innerText?.trim() || '';
  return { forum: text('.forum-name-main') + text('.forum-name-suffix'), urls: [...document.querySelectorAll('a.top-thread-card-item, a.thread-content-link')].filter(a => a.querySelector('.thread-title')?.innerText?.trim()).map(a => a.href) };
}
export function extractThreadDOM() {
  const root = document.querySelector('.center-content > .image-text');
  const text = (node, selector) => node?.querySelector(selector)?.innerText?.trim() || '';
  const bodyNode = root?.querySelector('.pb-content-wrap');
  return { forum: text(document, '.forum-name-main') + text(document, '.forum-name-suffix'), id: bodyNode?.querySelector('[tid]')?.getAttribute('tid') || '', title: text(root, '.pb-title'), body: bodyNode?.innerText?.trim() || '', time: text(root, '.desc-info .post-num'), truncated: !!bodyNode?.querySelector('.clamp-char, .text-overflow, .content-fold, .fold-btn') };
}
function canonicalCandidate(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.host !== 'tieba.baidu.com' || u.username || u.password || u.hash || !/^\/p\/[0-9]+$/.test(u.pathname)) return null;
    if ([...u.searchParams].some(([k, v]) => k !== 'fr' || v !== 'frs')) return null;
    return `https://tieba.baidu.com${u.pathname}`;
  } catch { return null; }
}
export function isAllowedRequest(request, expectedUrl) {
  let u; try { u = new URL(request.url()); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  const type = request.resourceType();
  if (request.isNavigationRequest()) return request.method() === 'GET' && request.url() === expectedUrl;
  if (STATIC_HOSTS.has(u.hostname)) return request.method() === 'GET' && ['script', 'stylesheet', 'font'].includes(type) && u.pathname.startsWith('/tb/pc/');
  // These fixed vendor scripts are required by the public site to render anonymously.
  if (request.method() === 'GET' && type === 'script' && ((u.hostname === 'dlswbr.baidu.com' && /^\/heicha\/mm\/\d+\/acs-\d+\.js$/.test(u.pathname)) || (u.hostname === 'banti-static.cdn.bcebos.com' && /^\/o\/static\/banti_[a-z0-9]+\.js$/.test(u.pathname)) || (u.hostname === 'passport.baidu.com' && u.pathname === '/passApi/js/wrapper.js'))) return true;
  if (u.hostname === 'tieba.baidu.com' && request.method() === 'GET' && ['fetch','xhr'].includes(type) && ['/mo/q/work/user','/mo/q/getConfigData','/mo/q/getUpConfigData','/c/f/pc/homeSidebarLeft','/c/f/pc/frsSidebarRight','/c/f/pc/pbSidebarRight'].includes(u.pathname)) return true;
  return u.hostname === 'tieba.baidu.com' && DATA_PATHS.has(u.pathname) && request.method() === 'POST' && ['fetch', 'xhr'].includes(type);
}

export function isForumEvidence(data, threadId) {
  if (!data || data.error_code !== 0 || data.forum?.name !== '肥鱼避难所' || data.forum?.is_exists !== 1) return false;
  return threadId === null || (typeof threadId === 'string' && /^[0-9]+$/.test(threadId) && String(data.thread?.id) === threadId);
}

// Inject chromium only for test; normal use launches a fresh anonymous Chromium process.
export function createTiebaPlaywrightSource({ chromium, executablePath, timeoutMs = 25000, authenticatedSession } = {}) {
  // This transport intentionally strips credentials; accepting a session here
  // would silently fall back to anonymous browsing without the required guards.
  if (authenticatedSession !== undefined) throw new Error('tieba_authenticated_session_unavailable');
  async function visit(url, selector, extractor, signal) {
    if (signal?.aborted) throw new Error('cancelled');
    const engine = chromium || (await import('playwright-core')).chromium;
    const browser = await engine.launch({ headless: true, ...(executablePath ? { executablePath } : {}), proxy: { server: 'http://tieba-block.invalid:9', bypass: '<-loopback>' }, args: ['--no-sandbox', '--disable-background-networking', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--host-resolver-rules=MAP * ~NOTFOUND'] });
    let context;
    const abort = () => { void browser.close().catch(() => {}); };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted) throw new Error('cancelled');
      context = await browser.newContext({ serviceWorkers: 'block', locale: 'zh-CN' });
      await context.addInitScript(() => {
        for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'WebTransport']) {
          Object.defineProperty(globalThis, name, { value: undefined, configurable: false, writable: false });
        }
      });
      await context.route('**/*', async route => {
        try {
          if (!isAllowedRequest(route.request(), url)) return await route.abort();
          const response = await fetchPinned(route.request(), timeoutMs, signal);
          await route.fulfill(response);
        } catch { await route.abort().catch(() => {}); }
      });
      if (!context.routeWebSocket) throw new Error('tieba_websocket_block_unavailable');
      await context.routeWebSocket('**/*', ws => ws.close());
      const page = await context.newPage();
      const threadId = url === LIST_URL ? null : url.slice(url.lastIndexOf('/') + 1);
      const apiPath = threadId === null ? '/c/f/frs/page_pc' : '/c/f/pb/page_pc';
      const evidenceResponse = page.waitForResponse(response => {
        const req = response.request();
        const target = new URL(response.url());
        if (target.origin !== 'https://tieba.baidu.com' || target.pathname !== apiPath || req.method() !== 'POST' || req.redirectedFrom() || !response.ok()) return false;
        const form = new URLSearchParams(req.postData() || '');
        return threadId === null ? form.get('kw') === encodeURIComponent('肥鱼避难所') : form.get('kz') === threadId;
      }, { timeout: timeoutMs });
      // Prevent an unhandled rejection if navigation fails before evidence arrives.
      evidenceResponse.catch(() => {});
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      if (!response || !response.ok() || page.url() !== url) throw new Error('tieba_navigation_failed');
      await page.waitForSelector(selector, { state: 'visible', timeout: timeoutMs });
      const evidence = await (await evidenceResponse).json();
      const result = await page.evaluate(extractor);
      if (page.url() !== url || !isForumEvidence(evidence, threadId)) throw new Error('tieba_wrong_forum_or_redirect');
      return result;
    } finally { signal?.removeEventListener('abort', abort); await context?.close().catch(() => {}); await browser.close().catch(() => {}); }
  }
  return {
    async list({ forum, signal } = {}) {
      if (forum !== FORUM) throw new Error('tieba_forum_not_allowed');
      const data = await visit(LIST_URL, '.thread-content-link .thread-title, .top-thread-card-item .thread-title', extractForumDOM, signal);
      const urls = [...new Set(data.urls.map(canonicalCandidate).filter(Boolean))];
      if (!urls.length) throw new Error('tieba_empty_or_unavailable_list');
      return urls.map(url => ({ url }));
    },
    async read({ url, forum, signal } = {}) {
      if (forum !== FORUM || !validateThreadUrl(url)) throw new Error('tieba_thread_not_allowed');
      const data = await visit(url, '.center-content > .image-text .pb-content-wrap', extractThreadDOM, signal);
      const id = url.slice(url.lastIndexOf('/') + 1);
      if (data.id !== id || !data.title || !data.body || !data.time || data.truncated || data.title.length > 500 || data.body.length > 20000) throw new Error('tieba_incomplete_thread');
      return { url, forum: FORUM, id, title: data.title, body: data.body, time: data.time };
    },
  };
}
