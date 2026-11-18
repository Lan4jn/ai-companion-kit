// Experimental TLS primitive, NOT a browser egress boundary. Do not enable the
// headed daemon without independent OS-level isolation and site validation.
import https from 'node:https';
import { authorizeCandidateRequest, resolveCandidateDestination } from './douyin-egress-candidate-policy.js';

// Low-level primitive: caller MUST authorize the method, URL and headers before
// calling. The destination hostname is fixed and every DNS answer is validated;
// the selected address is pinned into the TLS socket lookup. Never auto-follow.
// lookup, port and ca are for isolated synthetic testing, not browser input.
export async function requestPinnedCandidate({ url, method, headers = {}, body }, { lookup, port = 443, ca, timeoutMs = 8000, maxBytes = 1024 * 1024, signal } = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'www.douyin.com' || parsed.port || parsed.username || parsed.password || parsed.hash || !['GET', 'HEAD', 'POST'].includes(method)) throw new Error('candidate request denied');
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, {once:true});
  const timer = setTimeout(cancel, timeoutMs);
  try {
    if (controller.signal.aborted) throw new Error('candidate cancelled');
    const pinned = await Promise.race([
      resolveCandidateDestination('www.douyin.com', lookup),
      new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('candidate timeout')), { once: true })),
    ]);
    return await new Promise((resolve, reject) => {
      const request = https.request(parsed, {
        method, port, ca, agent: false, signal: controller.signal,
        servername: 'www.douyin.com', rejectUnauthorized: true,
        autoSelectFamily: false, family: pinned.family,
        lookup: (_host, options, callback) => options.all
          ? callback(null, [{ address: pinned.address, family: pinned.family }])
          : callback(null, pinned.address, pinned.family),
        headers,
      }, response => {
        let size = 0; const chunks = [];
        response.on('data', chunk => {
          size += chunk.length;
          if (size > maxBytes) response.destroy(new Error('candidate response too large'));
          else chunks.push(chunk);
        });
        response.on('error', () => reject(new Error('candidate response failed')));
        response.on('aborted', () => reject(new Error('candidate response aborted')));
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
      });
      request.on('error', () => reject(new Error('candidate transport failed')));
      request.end(body);
    });
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}

export async function readCandidatePage(input, options = {}) {
  const url = authorizeCandidateRequest('GET', input);
  if (!url) throw new Error('candidate request denied');
  const response = await requestPinnedCandidate({ url, method: 'GET', headers: { accept: 'text/html', 'accept-encoding': 'identity' } }, options);
  if (response.status !== 200) throw new Error('candidate response denied');
  return { status: response.status, body: response.body };
}
