// Candidate-only; caller supplies explicitly authorized scopes, never directory enumeration.
export function createMemoryMaintenance({enabled = false, brain, scopes = [], intervalMs = 86400000, onError = () => {}} = {}) {
 if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > 2147483647) throw new Error('invalid maintenance interval');
 if (!Array.isArray(scopes) || scopes.length > 1000) throw new Error('invalid maintenance scopes');
 const entries = scopes.map(({context, source}) => Object.freeze({context:Object.freeze({...context}), source}));
 let pending = null, timer = null, stopped = false;
 async function runOnce() {
  if (enabled !== true || stopped) return false;
  if (pending) return pending;
  pending = (async () => { for (const entry of entries) await brain.cleanup(entry.context, {source:entry.source}); return true; })();
  try { return await pending; } finally { pending = null; }
 }
 function start() {
  if (enabled !== true || stopped || timer) return false;
  timer = setInterval(() => { runOnce().catch(() => { try { onError(new Error('memory maintenance failed')); } catch {} }); }, intervalMs);
  timer.unref();
  return true;
 }
 async function stop() { stopped = true; if (timer) clearInterval(timer); timer = null; if (pending) await pending; }
 return Object.freeze({start, stop, runOnce});
}
