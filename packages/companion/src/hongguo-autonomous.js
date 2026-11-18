// An inert, caller-driven cycle: no timers, production wiring, navigation, or sending.
import { observeHongguo } from './hongguo-capture.js';

// Scheduling is opt-in and caller-driven: creating this object starts nothing.
export function createHongguoScheduler({ intervalMs = 3600000, now = Date.now } = {}) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0 || typeof now !== 'function') throw new Error('invalid scheduler configuration');
  let busy = false;
  let last = null;
  return {
    async tick(options = {}) {
      if (options.permission !== true) return { status: 'permission_required' };
      if (busy) return { status: 'busy' };
      const time = now();
      if (!Number.isFinite(time)) return { status: 'clock_unavailable' };
      if (last !== null && time - last < intervalMs) return { status: 'not_due' };
      busy = true;
      last = time;
      try { return await runHongguoCycle(options); }
      finally { busy = false; }
    },
  };
}

export async function runHongguoCycle({ permission, brain, observation, navigate, context = '', prepareContext, timeoutMs = 30000 } = {}) {
  if (permission !== true) return { status: 'permission_required' };
  if (typeof brain?.complete !== 'function') return { status: 'decision_unavailable' };
  if (typeof prepareContext === 'function') {
    try { context = await prepareContext(context); }
    catch { return { status: 'unverified' }; }
  }
  let timer;
  let decision;
  try {
    const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000;
    const raw = await Promise.race([
      Promise.resolve().then(() => brain.complete({
        system: '你自己决定是否想看红果短剧，跳过也完全可以。不要编造观看经历，只输出JSON。',
        prompt: `根据真实上下文决定是否想看。上下文：${typeof context === 'string' ? context.slice(0, 3000) : ''}\n只输出 {"want":true或false}。`,
        max_tokens: 1000, temperature: 0.4, json: true,
      })),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), timeout); }),
    ]);
    if (typeof raw !== 'string') return { status: 'decision_unavailable' };
    decision = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
    if (typeof decision?.want !== 'boolean') return { status: 'decision_unavailable' };
  } catch {
    return { status: 'decision_unavailable' };
  } finally {
    clearTimeout(timer);
  }
  if (!decision.want) return { status: 'skipped' };
  try {
    if (typeof navigate === 'function') return await navigate();
    const assessment = await observeHongguo(observation);
    return { status: assessment.verified ? 'verified' : 'unverified', assessment };
  } catch {
    return { status: 'unverified' };
  }
}
