// Candidate lifecycle primitive only. This does not allocate an identity, create
// a sandbox, authenticate a peer, or enable production handoff. The caller must
// run it in a trusted independent supervisor and supply a sandboxed backend.
export function createSessionLease({enabled = false, launch, ttlMs, peer, shutdownTimeoutMs = 5000} = {}) {
  if (enabled !== true) throw Error('session lease disabled');
  if (typeof launch !== 'function' || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 3600000 ||
      !Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 1 || shutdownTimeoutMs > 60000 ||
      !peer || typeof peer.once !== 'function' || typeof peer.removeListener !== 'function' || peer.destroyed !== false) {
    throw Error('invalid session lease');
  }
  let state = 'starting';
  let reason;
  let resource;
  let cleanupPromise;
  let timer;
  let shutdownTimer;
  const abort = new AbortController();
  let resolveStopped;
  const stopped = new Promise(resolve => { resolveStopped = resolve; });
  const detach = () => {
    clearTimeout(timer);
    peer.removeListener('close', onPeerClose);
    peer.removeListener('error', onPeerError);
  };
  let settled = false;
  const finish = (cleaned, finalReason = reason) => {
    if (settled) return;
    settled = true;
    clearTimeout(shutdownTimer);
    state = cleaned ? 'stopped' : 'cleanup_failed';
    detach();
    resolveStopped({reason: finalReason, cleaned});
  };
  // A deadline reports uncertainty; it cannot itself terminate a backend.
  // Even after timeout, close any late resource without revising that result.
  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = Promise.resolve().then(() => resource.close()).then(
      () => finish(true), () => finish(false)
    );
    return cleanupPromise;
  };
  const cancel = (why = 'cancelled') => {
    if (state === 'stopped' || state === 'cleanup_failed') return stopped;
    if (!reason) {
      reason = why;
      state = 'stopping';
      shutdownTimer = setTimeout(() => finish(false), shutdownTimeoutMs);
      abort.abort();
    }
    if (resource) void cleanup();
    return stopped;
  };
  const onPeerClose = () => { void cancel('peer_closed'); };
  const onPeerError = () => { void cancel('peer_error'); };
  peer.once('close', onPeerClose);
  peer.once('error', onPeerError);
  timer = setTimeout(() => { void cancel('expired'); }, ttlMs);
  // Handle a close racing the initial destroyed check and listener installation.
  if (peer.destroyed !== false) void cancel('peer_closed');
  const skipped = Symbol('launch skipped');
  const started = Promise.resolve().then(() => {
    if (reason) return skipped;
    return launch({signal: abort.signal});
  }).then(value => {
    if (value === skipped) {
      finish(true);
      return false;
    }
    if (!value || typeof value.close !== 'function') throw Error('invalid session resource');
    resource = value;
    if (reason) { void cleanup(); return false; }
    state = 'running';
    return true;
  }, () => {
    finish(false, reason || 'launch_failed');
    return false;
  }).catch(() => {
    finish(false, reason || 'launch_failed');
    return false;
  });
  return Object.freeze({started, stopped, cancel, get state() { return state; }});
}
