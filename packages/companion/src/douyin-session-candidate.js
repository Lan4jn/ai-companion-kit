// Offline design candidate only: deliberately not wired to production or a browser.
// An eventual trusted broker must own the browser and credential boundary; neither
// cookies nor browser objects cross this interface. Do not treat this coordinator
// as evidence that the broker or official login is secure or implemented.
export function createDouyinSessionCandidate({ broker }) {
  if (!broker || typeof broker.verify !== 'function' || typeof broker.watch !== 'function' || typeof broker.close !== 'function') {
    throw new TypeError('invalid session broker');
  }
  let state = 'unverified';
  let generation = 0;
  let running = false;
  let closing;
  const invalidate = async next => {
    if (state === 'closed') return;
    generation++;
    state = next;
    closing ||= Promise.resolve().then(() => broker.close()).catch(() => {});
    await closing;
  };
  return Object.freeze({
    status: () => state,
    async verify() {
      if (state !== 'unverified' || running) return { ok: false, reason: 'unavailable' };
      running = true;
      const current = generation;
      try {
        const result = await broker.verify();
        if (current !== generation) return { ok: false, reason: 'cancelled' };
        if (result?.state !== 'online') {
          await invalidate(result?.state === 'risk' ? 'risk' : 'unavailable');
          return { ok: false, reason: state };
        }
        state = 'ready';
        return { ok: true };
      } catch {
        if (current !== generation) return { ok: false, reason: 'cancelled' };
        await invalidate('unavailable');
        return { ok: false, reason: 'unavailable' };
      } finally { running = false; }
    },
    async watch(workId) {
      if (state !== 'ready' || running) return { ok: false, reason: 'unavailable' };
      // IDs only; never accept arbitrary URL, credentials, or interaction commands.
      if (typeof workId !== 'string' || !/^\d{1,32}$/.test(workId)) return { ok: false, reason: 'invalid_work' };
      running = true;
      const current = generation;
      try {
        const result = await broker.watch(workId);
        if (current !== generation) return { ok: false, reason: 'cancelled' };
        if (result?.state === 'risk' || result?.state === 'challenge') {
          await invalidate('risk');
          return { ok: false, reason: 'risk' };
        }
        if (result?.state !== 'complete' || result.workId !== workId) return { ok: false, reason: 'unconfirmed' };
        return { ok: true, workId };
      } catch {
        if (current !== generation) return { ok: false, reason: 'cancelled' };
        await invalidate('unavailable');
        return { ok: false, reason: 'unavailable' };
      } finally { running = false; }
    },
    async close() { await invalidate('closed'); state = 'closed'; },
  });
}
