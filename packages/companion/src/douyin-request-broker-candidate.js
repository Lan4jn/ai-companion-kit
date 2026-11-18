// Experimental request broker; not wired into the headed login entry.
// A token is a capability, not process identity: a hostile process able to read
// the client memory can impersonate it. OS principal isolation is still required.
import http from 'node:http';
import crypto from 'node:crypto';
import net from 'node:net';
import { requestPinnedCandidate } from './douyin-egress-candidate-transport.js';
import { createRestrictedEgress } from './douyin-configurable-egress-candidate.js';

const MAX_ENVELOPE = 16384;
const MAX_BODY = 4096;
const FORWARDED = new Set(['accept', 'content-type', 'cookie', 'origin', 'referer']);

export function createCandidateBroker({ token, transportOptions = {}, fixturePolicy, policy = {}, inheritedFd, inheritedSocket } = {}) {
  if (inheritedFd !== undefined && inheritedSocket !== undefined) throw Error('ambiguous broker transport');
  const inherited = inheritedFd !== undefined || inheritedSocket !== undefined;
  if (inheritedSocket !== undefined && (!(inheritedSocket instanceof net.Socket) || inheritedSocket.destroyed)) throw Error('invalid broker stream');
  if (inherited ? ((inheritedFd !== undefined && (!Number.isInteger(inheritedFd) || inheritedFd < 3)) || token !== undefined) : (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token))) throw Error('invalid broker capability');
  if (fixturePolicy && !process.env.NODE_TEST_CONTEXT) throw Error('fixture policy unavailable');
  const restricted = createRestrictedEgress(policy);
  const authorize = fixturePolicy || restricted.authorize;
  const secret = inherited ? null : Buffer.from(token);
  let closed = false;
  const active = new Set();
  const pending = new Set();
  let inFlight = 0;
  const server = http.createServer({ maxHeaderSize: 4096 }, (req, res) => {
    if (req.socket.destroyed) return;
    if (inFlight >= 4) { req.socket.destroy(); return; }
    inFlight++;
    let released = false;
    const release = () => { if (!released) { released = true; inFlight--; req.socket.emit('dy-response-end'); } };
    res.once('finish', release);
    res.once('close', release);
    const deny = (status = 403) => { if (!res.headersSent) res.writeHead(status, {'cache-control':'no-store','content-type':'text/plain'}); res.end('denied'); };
    const supplied = Buffer.from(req.headers.authorization || '');
    const expected = secret ? Buffer.from(`Bearer ${secret.toString()}`) : null;
    const authorized = inherited ? !req.headers.authorization : supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
    if (closed || req.method !== 'POST' || req.url !== '/request' || !authorized || req.headers.upgrade || req.headers['transfer-encoding']) {
      // Never drain an untrusted incomplete body on the sole broker stream.
      // Closing also prevents pipelined bytes from becoming another request.
      res.setHeader('connection', 'close');
      res.once('finish', () => req.socket.destroy());
      return deny();
    }
    // Bound the entire upload, not merely socket inactivity: a slow trickle on
    // the single inherited stream must not retain the broker indefinitely.
    const envelopeTimer = setTimeout(() => req.socket.destroy(), 5000);
    envelopeTimer.unref();
    const clearEnvelopeTimer = () => clearTimeout(envelopeTimer);
    req.once('end', clearEnvelopeTimer);
    req.once('close', clearEnvelopeTimer);
    let size = 0, chunks = [], failed = false;
    req.on('data', chunk => { size += chunk.length; if (size > MAX_ENVELOPE) { failed = true; chunks = []; req.socket.destroy(); } else if (!failed) chunks.push(chunk); });
    req.on('error', () => { failed = true; });
    req.on('end', async () => {
      if (failed || closed) return deny();
      try {
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(k => !['url','method','headers','body'].includes(k))) return deny();
        if (typeof data.url !== 'string' || typeof data.method !== 'string' || !authorize(data.method, data.url)) return deny();
        // Fixture callback retains the old fixed-host transport; configurable
        // policy is enforced again by its own pinned TLS transport.
        const u = new URL(data.url);
        if (fixturePolicy && (u.protocol !== 'https:' || u.host !== 'www.douyin.com' || u.username || u.password || u.hash)) return deny();
        if (!data.headers || typeof data.headers !== 'object' || Array.isArray(data.headers)) return deny();
        const headers = {};
        for (const [name,value] of Object.entries(data.headers)) {
          if (!FORWARDED.has(name) || typeof value !== 'string' || value.length > 4096 || /[\r\n\0]/.test(value)) return deny();
          headers[name] = value;
        }
        if (headers.origin && headers.origin !== u.origin) return deny();
        if (headers.referer && (!headers.referer.startsWith(u.origin + '/') || /[\\\x00-\x20\x7f]/.test(headers.referer))) return deny();
        if (data.body !== undefined && (typeof data.body !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data.body))) return deny();
        const body = data.body === undefined ? undefined : Buffer.from(data.body, 'base64');
        if (body?.length > MAX_BODY || (body?.length && ['GET','HEAD'].includes(data.method))) return deny();
        const controller = new AbortController();
        const abortDisconnected = () => { if (!res.writableFinished) controller.abort(); };
        res.once('close', abortDisconnected);
        if (res.destroyed) controller.abort();
        pending.add(controller);
        let response;
        try {
          const input={url:data.url, method:data.method, headers, body};
          response = fixturePolicy
            ? await requestPinnedCandidate({...input,headers:{...headers,'accept-encoding':'identity'}}, {...transportOptions, signal:controller.signal})
            : await restricted.request(input, {...transportOptions, maxRedirects:0, signal:controller.signal});
        }
        finally { pending.delete(controller); res.removeListener('close', abortDisconnected); }
        if (closed || response.status !== 200) return deny(); // Includes every redirect, without forwarding Location or cookies.
        const outHeaders = {};
        for (const name of ['content-type','set-cookie']) if (response.headers[name]) outHeaders[name] = response.headers[name];
        res.writeHead(200, {'content-type':'application/json','cache-control':'no-store'});
        res.end(JSON.stringify({status:200, headers:outHeaders, body:response.body.toString('base64')}));
      } catch { deny(); }
    });
  });
  // The inherited stream is the only transport and cannot reconnect. An idle
  // human challenge may last minutes, so bound requests, not stream idle time.
  if (inherited) server.keepAliveTimeout = 0;
  server.on('connection', socket => {
    if (closed || active.size >= (inherited ? 1 : 8)) { socket.destroy(); return; }
    active.add(socket);
    // Independently track framing before Node's HTTP parser sees each chunk.
    // A single chunk can finish a body and start several subsequent headers.
    // Count parsed envelopes until their responses finish, including responses
    // buffered behind an earlier slow response.
    let header = Buffer.alloc(0), remaining = 0, headerTimer, outstanding = 0;
    const clearHeader = () => { clearTimeout(headerTimer); headerTimer = undefined; };
    socket.prependListener('data', chunk => {
      let offset = 0;
      while (offset < chunk.length && !socket.destroyed) {
        if (remaining) {
          const n = Math.min(remaining, chunk.length - offset);
          remaining -= n; offset += n;
          continue;
        }
        if (!headerTimer) {
          headerTimer = setTimeout(() => socket.destroy(), 5000);
          headerTimer.unref();
        }
        // Bound the scanner independently of Node's parser.
        const available = chunk.subarray(offset);
        const combined = Buffer.concat([header, available.subarray(0, 4100 - header.length)]);
        const end = combined.indexOf('\r\n\r\n');
        if (end < 0) {
          if (combined.length > 4096) { socket.destroy(); return; }
          header = combined;
          return;
        }
        if (end + 4 > 4096) { socket.destroy(); return; }
        offset += end + 4 - header.length;
        const lines = combined.subarray(0, end).toString('latin1').split('\r\n').slice(1);
        const lengths = lines.filter(line => /^content-length\s*:/i.test(line));
        if (lengths.length > 1 || lines.some(line => /^transfer-encoding\s*:/i.test(line))) { socket.destroy(); return; }
        let length = 0;
        if (lengths.length) {
          const match = /^content-length:\s*(\d+)\s*$/i.exec(lengths[0]);
          if (!match || !Number.isSafeInteger(length = Number(match[1])) || length > MAX_ENVELOPE) { socket.destroy(); return; }
        }
        if (++outstanding > 4) { socket.destroy(); return; }
        remaining = length; header = Buffer.alloc(0); clearHeader();
      }
    });
    socket.on('close', () => { clearHeader(); active.delete(socket); });
    socket.on('dy-response-end', () => { outstanding--; });
    if (!inherited) socket.setTimeout(10000, () => socket.destroy());
  });
  server.on('connect', (req, socket) => socket.destroy());
  server.on('upgrade', (req, socket) => socket.destroy());
  if (inherited) {
    const socket = inheritedSocket || new net.Socket({fd: inheritedFd, readable: true, writable: true});
    server.emit('connection', socket);
    socket.resume();
  }
  return { ...(inherited ? {} : {server}), async close() { closed = true; for (const controller of pending) controller.abort(); for (const socket of active) socket.destroy(); if (server.listening) await new Promise(resolve => server.close(resolve)); } };
}
