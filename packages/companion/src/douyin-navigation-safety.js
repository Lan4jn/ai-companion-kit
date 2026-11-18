import dns from 'node:dns/promises';
import https from 'node:https';
import { isPublicAddress } from './web-evidence.js';

function secureUrl(value) {
  try {
    // Reject URL parser normalization of dot segments, encoded paths or backslashes.
    if (typeof value !== 'string' || /[\\\x00-\x20]/.test(value)) return null;
    const rawPath = value.match(/^https:\/\/[^/?#]+([^?#]*)/i)?.[1] || '';
    if (/%|(?:^|\/)\.{1,2}(?:\/|$)/.test(rawPath)) return null;
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port ? u : null;
  } catch { return null; }
}
const navigationHosts = new Set(['v.douyin.com', 'www.douyin.com', 'douyin.com']);
// Observed on the anonymous official work page. These are exact CDN hosts,
// not blanket trust in their shared parent domains or other object buckets.
const staticHosts = new Set(['lf-douyin-pc-web.douyinstatic.com', 'lf-douyin-pc-web-back.douyinstatic.com', 'lf3-cdn-tos.bytegoofy.com']);
function allowedStatic(u) {
  return staticHosts.has(u.hostname) && !u.search && !u.hash && /^\/obj\/douyin-pc-web\/ies\/douyin_web\/(?:[A-Za-z0-9_~.-]+\/)*[A-Za-z0-9_~.-]+\.[a-f0-9]{8}\.(?:js|css)$/.test(u.pathname);
}
const resourceDomains = ['douyin.com', 'douyinvod.com', 'douyinpic.com', 'byteimg.com', 'bytecdn.cn', 'bytedance.com', 'bytedance.net', 'ixigua.com', 'snssdk.com', 'pstatp.com', 'ibytedtos.com'];
function validNavigation(u) {
  if (!navigationHosts.has(u.hostname)) return false;
  // Redirect-like query parameters can turn a trusted endpoint into an open redirect.
  for (const [key, value] of u.searchParams) {
    if (/^(?:next|redirect|redirect_uri|redirect_url|url|target|return|return_url|callback|continue)$/i.test(key) || /(?:https?:|\/\/|\\)/i.test(value)) return false;
  }
  if (u.hostname === 'v.douyin.com') {
    const match = u.pathname.match(/^\/([A-Za-z0-9]{3,32})\/?$/);
    return !!match && !/^(?:logout|login|signin|signout|account|settings|redirect|user|oauth|api|admin)$/i.test(match[1]);
  }
  return /^\/(?:video|note)\/\d+\/?$/.test(u.pathname);
}
export function douyinRequestAllowed(value, navigation = false) {
  const u = secureUrl(value);
  if (!u) return false;
  return navigation ? validNavigation(u) : allowedStatic(u) || resourceDomains.some(d => u.hostname === d || u.hostname.endsWith('.' + d));
}

// Resolve and pin the validated address to the actual TLS socket. Checking DNS and
// then using route.fetch would perform a second lookup and permit rebinding.
async function pinnedFetch(req) {
  const url = new URL(req.url());
  const addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) throw new Error('unsafe DNS');
  const address = addresses[0];
  const headers = await req.allHeaders();
  delete headers['proxy-authorization'];
  delete headers['proxy-connection'];
  if (staticHosts.has(url.hostname)) {
    delete headers.cookie;
    delete headers.authorization;
  }
  const body = req.postDataBuffer();
  return new Promise((resolve, reject) => {
    const request = https.request(url, { method: req.method(), headers, lookup: (_host, opts, cb) => opts.all ? cb(null, [address]) : cb(null, address.address, address.family), timeout: 15000 }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 32 * 1024 * 1024) response.destroy(new Error('response too large')); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => {
        const responseHeaders = { ...response.headers };
        delete responseHeaders['transfer-encoding'];
        // Playwright requires string header values.
        for (const [key, value] of Object.entries(responseHeaders)) if (Array.isArray(value)) responseHeaders[key] = value.join('\n');
        resolve({ status: response.statusCode, headers: responseHeaders, body: Buffer.concat(chunks) });
      });
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
    request.end(body || undefined);
  });
}
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
export async function installDouyinRequestGuard(context) {
  // Redirects fulfilled as 3xx are followed by Chromium without another route
  // callback. Never return a 3xx to it: use a fresh, guarded navigation instead.
  const redirects = new WeakMap();
  if (typeof context.routeWebSocket !== 'function') throw new Error('Playwright WebSocket routing required');
  await context.routeWebSocket('**/*', ws => ws.close({ code: 1008, reason: 'WebSocket blocked' }));
  await context.route('**/*', async route => {
    const req = route.request();
    const navigation = req.isNavigationRequest();
    if (!douyinRequestAllowed(req.url(), navigation) || typeof req.method !== 'function' || !['GET', 'HEAD'].includes(req.method())) return route.abort();
    try {
      const frame = navigation ? req.frame() : null;
      const previous = frame && redirects.get(frame);
      const count = previous?.url === req.url() ? previous.count : 0;
      if (frame) redirects.delete(frame);
      const response = await pinnedFetch(req);
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.location;
        if (!navigation || !location || count >= MAX_REDIRECTS || /[\\\\\x00-\x20]/.test(location) || /%|(?:^|\/)\.{1,2}(?:\/|$)/.test(location.split(/[?#]/, 1)[0])) throw new Error('unsafe redirect');
        const next = new URL(location, req.url()).href;
        if (!douyinRequestAllowed(next, true)) throw new Error('unsafe redirect target');
        redirects.set(frame, { url: next, count: count + 1 });
        const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
        if (response.headers['set-cookie']) headers['set-cookie'] = response.headers['set-cookie'];
        const encoded = JSON.stringify(next).replace(/</g, '\\u003c');
        await route.fulfill({ status: 200, headers, body: `<script>location.replace(${encoded})</script>` });
      } else if (response.status >= 300 && response.status < 400) {
        throw new Error('unsupported redirect status');
      } else {
        await route.fulfill(response);
      }
    } catch {
      // Aborting a script-driven navigation can restore the redirect document,
      // causing Chromium to execute its redirect script again indefinitely.
      if (navigation) await route.fulfill({ status: 502, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' }, body: 'Navigation blocked' }).catch(() => {});
      else await route.abort().catch(() => {});
    }
  });
}
export function douyinWorkTarget(original, final) {
  const start = secureUrl(original), end = secureUrl(final);
  if (!start || !end || !validNavigation(start) || !validNavigation(end) || !['www.douyin.com','douyin.com'].includes(end.hostname)) return null;
  const work = u => u.pathname.match(/^\/(video|note)\/(\d+)\/?$/);
  const target = work(end), initial = work(start);
  if (!target || (start.hostname !== 'v.douyin.com' && (!initial || initial[1] !== target[1] || initial[2] !== target[2]))) return null;
  return end.href;
}
