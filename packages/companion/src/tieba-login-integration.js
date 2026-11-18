// No authoritative identity protocol has been established. Never derive identity
// from caller supplied DOM, cookies, URL, or a claimed successful response.
// This fail-closed placeholder performs no request and cannot authenticate.
export async function verifyOfficialTiebaIdentity() {
  return { state: 'unknown' };
}

// Candidate composition only. No production session factory or identity verifier
// is provided: callers must not treat cookie presence as identity evidence.
// Caller must provide the isolated browser and owner-operated handoff; this
// factory never implements, infers, or reports a real Baidu identity protocol.
export function createOwnerTiebaSessionFactory({ enabled = false, openOwnerSession, ttlMs = 300000 } = {}) {
  if (enabled !== true || typeof openOwnerSession !== 'function' || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 1800000) throw Error('tieba_candidate_unavailable');
  return async () => {
    const raw = await openOwnerSession();
    if (typeof raw?.close !== 'function' || typeof raw?.context?.cookies !== 'function') {
      await raw?.close?.().catch(() => {});
      throw Error('tieba_candidate_unavailable');
    }
    let active = true, closing;
    const lifetime = new AbortController();
    const disconnect = () => { void close().catch(() => {}); };
    const close = () => closing ||= (async () => {
      active = false; clearTimeout(timer); raw.signal?.removeEventListener('abort', disconnect);
      lifetime.abort(); await raw.close();
    })();
    const timer = setTimeout(disconnect, ttlMs);
    timer.unref();
    raw.signal?.addEventListener('abort', disconnect, { once: true });
    if (raw.signal?.aborted) disconnect();
    return Object.freeze({ context: raw.context, signal: lifetime.signal,
      waitForCompletion: typeof raw.waitForCompletion === 'function' ? () => raw.waitForCompletion() : undefined,
      isActive: () => active && (!raw.isActive || raw.isActive()), close });
  };
}

import { createTiebaReadOnlyCandidate, createTiebaCandidateSource } from './tieba-trusted-session-bridge.js';

// Explicitly injected owner handoff and verifier only. No official verifier is
// provided; real account identity and deployment remain unverified.
export function createTiebaCandidateFactory({ enabled = false, openOwnerSession, verifyIdentity, listSource, transportOptions, createTransport, executablePath, ttlMs } = {}) {
  if (enabled !== true || typeof openOwnerSession !== 'function' || typeof verifyIdentity !== 'function' || typeof listSource?.list !== 'function' || (createTransport !== undefined && typeof createTransport !== 'function')) throw Error('tieba_candidate_unavailable');
  return () => createTiebaLoginIntegration({ createSession: createOwnerTiebaSessionFactory({ enabled: true, openOwnerSession, ttlMs }), verifyIdentity, listSource, transportOptions, createTransport, executablePath, requireSubject: true });
}

// Custom transports are trusted code, not request input. They must independently
// enforce egress, read-only access and cancellation; no official implementation exists.
export function createTiebaLoginIntegration({ createSession, verifyIdentity, listSource, transportOptions = {}, createTransport, executablePath, requireSubject = false } = {}) {
  if (typeof createSession !== 'function' || typeof verifyIdentity !== 'function' || typeof listSource?.list !== 'function') throw new Error('tieba_candidate_unavailable');
  let session = null, pendingSession = null, source = null, state = 'unknown', closed = false, starting = null, cancelling = null, generation = 0, boundSubject = null, startAbort = null;
  let lifetime = new AbortController();
  // Race non-cooperative dependencies without losing ownership of late resources.
  async function interruptible(operation, signal, disposeLate) {
    let onAbort;
    const work = Promise.resolve().then(operation);
    const cancelled = new Promise((_, reject) => {
      onAbort = () => {
        if (disposeLate) work.then(value => Promise.resolve().then(() => disposeLate(value)).catch(() => {}), () => {});
        reject(Error('unavailable'));
      };
      if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, {once:true});
    });
    try {
      const value = await Promise.race([work, cancelled]);
      if (signal.aborted) throw Error('unavailable');
      return value;
    } finally { signal.removeEventListener('abort', onAbort); }
  }
  const sessionClosures = new WeakMap();
  async function closeSession(s, adapter) {
    try { await Promise.resolve().then(() => adapter?.close()); } catch {}
    if (s && (typeof s === 'object' || typeof s === 'function')) {
      if (!sessionClosures.has(s)) sessionClosures.set(s, Promise.resolve().then(() => s.close?.()).catch(() => {}));
      await sessionClosures.get(s);
    }
  }
  async function start() {
    if (closed || starting || cancelling) return { state: 'unknown' };
    if (source) return refresh();
    const id = generation;
    const controller = new AbortController(); startAbort = controller;
    starting = (async () => {
      let s, adapter;
      try {
        s = await interruptible(() => createSession(), controller.signal, late => closeSession(late));
        if (closed || id !== generation || typeof s?.close !== 'function' || typeof s?.context?.cookies !== 'function') throw Error('unavailable');
        pendingSession = s;
        if (typeof s.waitForCompletion === 'function') {
          const signal = s.signal;
          let onAbort;
          const aborted = new Promise((_, reject) => {
            onAbort = () => reject(Error('unavailable'));
            if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
          });
          try { await interruptible(() => Promise.race([Promise.resolve().then(() => s.waitForCompletion()), aborted]), controller.signal); }
          finally { signal?.removeEventListener('abort', onAbort); }
          if (closed || id !== generation || (s.isActive && !s.isActive())) throw Error('unavailable');
        }
        let onStartAbort;
        const aborted = new Promise((_, reject) => {
          onStartAbort = () => reject(Error('unavailable'));
          if (controller.signal.aborted) onStartAbort();
          else controller.signal.addEventListener('abort', onStartAbort, { once: true });
        });
        let evidence;
        try { evidence = await Promise.race([Promise.resolve().then(() => verifyIdentity(s.context)), aborted]); }
        finally { controller.signal.removeEventListener('abort', onStartAbort); }
        if (closed || id !== generation || (s.isActive && !s.isActive()) || evidence?.state !== 'online' || (requireSubject && (typeof evidence.subject !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(evidence.subject)))) throw Error('unavailable');
        const transport = createTransport ? await interruptible(() => createTransport(s.context), controller.signal, late => late?.close?.()) : createTiebaReadOnlyCandidate({ ...transportOptions, context: s.context });
        try { adapter = createTiebaCandidateSource({ transport, listSource, executablePath }); }
        catch (error) { try { await Promise.resolve().then(() => transport?.close?.()); } catch {} throw error; }
        if (closed || id !== generation || (s.isActive && !s.isActive())) throw Error('unavailable');
        session = s; source = adapter; boundSubject = typeof evidence.subject === 'string' && evidence.subject.length ? evidence.subject : null; state = 'online'; pendingSession = null; s = null; adapter = null;
      } catch { state = 'unknown'; }
      finally { if (pendingSession === s) pendingSession = null; await closeSession(s, adapter); }
      return { state };
    })();
    try { return await starting; } finally { starting = null; if (startAbort === controller) startAbort = null; }
  }
  async function refresh() {
    const s = session, adapter = source, id = generation;
    if (closed || !s || !adapter) return { state: 'unknown' };
    let verified = false;
    try {
      const evidence = await interruptible(() => verifyIdentity(s.context), lifetime.signal);
      verified = (!s.isActive || s.isActive()) && evidence?.state === 'online' && (boundSubject === null || evidence.subject === boundSubject);
    } catch {}
    if (!verified && id === generation && session === s) {
      generation++; session = null; source = null; boundSubject = null; state = 'unknown';
      await closeSession(s, adapter);
    }
    return { state: !closed && verified && id === generation && session === s ? 'online' : 'unknown' };
  }
  async function cancel() {
    if (cancelling) return cancelling;
    generation++; state = 'unknown'; startAbort?.abort(); lifetime.abort(); lifetime = new AbortController();
    const s = session, adapter = source, pending = starting;
    session = null; source = null; boundSubject = null;
    cancelling = (async () => { await closeSession(s, adapter); if (pendingSession) await closeSession(pendingSession); await pending; })();
    try { await cancelling; } finally { cancelling = null; }
    return { state: 'unknown' };
  }
  const provider = Object.freeze({ start, status: refresh, cancel });
  async function guardedRead(method, options) {
    if ((await refresh()).state !== 'online' || !source) throw Error('tieba_candidate_unavailable');
    const adapter = source, s = session, id = generation;
    try {
      const result = await adapter[method](options);
      if (closed || generation !== id || source !== adapter || (s.isActive && !s.isActive())) throw Error('tieba_candidate_unavailable');
      if ((await refresh()).state !== 'online' || closed || generation !== id || source !== adapter) throw Error('tieba_candidate_unavailable');
      return result;
    } catch {
      if (generation === id && source === adapter) {
        generation++; session = null; source = null; boundSubject = null; state = 'unknown';
        await closeSession(s, adapter);
      }
      throw Error('tieba_candidate_unavailable');
    }
  }
  const guardedSource = Object.freeze({
    list: options => guardedRead('list', options),
    read: options => guardedRead('read', options),
  });
  async function close() {
    if (closed) return;
    closed = true; generation++; state = 'unknown'; startAbort?.abort(); lifetime.abort();
    const s = session, adapter = source; session = null; source = null; boundSubject = null;
    await closeSession(s, adapter);
    if (pendingSession) await closeSession(pendingSession);
    await starting;
    await cancelling;
  }
  return Object.freeze({ provider, source: guardedSource, close });
}
