// Only an explicit boolean decision is a decision; failures must not look like refusal.
export function createFanqieWant({ brain, context = async () => '', timeoutMs = 30000, signal } = {}) {
  return async function want() {
    let timer;
    let expired = false;
    const controller = new AbortController();
    const cancel = () => { expired = true; controller.abort(); };
    signal?.addEventListener('abort', cancel, {once:true});
    if (signal?.aborted) cancel();
    try {
      if (typeof brain?.complete !== 'function') throw new Error('decision unavailable');
      const decide = async () => {
        if (expired) throw new Error('decision unavailable');
        const details = await context({signal:controller.signal});
        if (expired) throw new Error('decision unavailable');
        const raw = await brain.complete({
          system: '你自己决定现在是否想读番茄小说，想读和不想读都可以。只输出JSON，不要编造阅读经历。',
          prompt: `根据目前真实上下文，自主决定现在想不想阅读。不必为了完成任务而阅读；上下文不足时也可以自行决定。\n上下文：${typeof details === 'string' ? details.slice(0, 3000) : ''}\n只输出 {"want":true或false}。`,
          max_tokens: 1000, temperature: 0.4, json: true,
        });
        if (typeof raw !== 'string') throw new Error('decision unavailable');
        const result = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
        if (typeof result?.want !== 'boolean') throw new Error('decision unavailable');
        return result.want;
      };
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => { cancel(); reject(new Error('decision unavailable')); },
          Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000);
      });
      const aborted = new Promise((_, reject) => {
        if (controller.signal.aborted) reject(new Error('decision unavailable'));
        else controller.signal.addEventListener('abort', () => reject(new Error('decision unavailable')), {once:true});
      });
      return await Promise.race([decide(), timeout, aborted]);
    } catch {
      throw new Error('decision unavailable');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  };
}
