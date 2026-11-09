/**
 * 死循环守卫。
 *
 * 她现在的工具链只有一轮（调用 → 执行 → 再答），不会无限调工具；
 * 真正会发生的"卡住"是这三种：
 *   1. 同一句话反复说（模型卡在某个模式里）
 *   2. 短时间刷屏（频率失控）
 *   3. 连续输出空内容（模型返回了 tool_calls 却没人接着执行）
 *
 * 这里的策略是"发现就拦，记一笔，让人知道"，不静默吞掉。
 */
export class LoopGuard {
  constructor({ windowMs = 120_000, maxSame = 2, maxPerWindow = 10, maxEmpty = 2 } = {}) {
    this.windowMs = windowMs;       // 时间窗口（默认 2 分钟）
    this.maxSame = maxSame;         // 窗口内最多允许同一句话重复几次
    this.maxPerWindow = maxPerWindow; // 窗口内最多允许的发言条数
    this.maxEmpty = maxEmpty;       // 最多允许连续几次空回复
    this.state = new Map();         // key -> Array<{ text, at, empty }>
    this.trips = new Map();         // key -> 触发过几次拦截（用于告警）
  }

  _recent(key) {
    const now = Date.now();
    const arr = (this.state.get(key) || []).filter((x) => now - x.at < this.windowMs);
    this.state.set(key, arr);
    return arr;
  }

  /**
   * 发言前检查。返回 { block, reason, silent }。
   * silent=true 表示"这次不吭声就对了"，不需要给用户任何提示。
   */
  check(key, text, { bypassFrequency = false } = {}) {
    const k = String(key || 'default');
    const arr = this._recent(k);
    const t = String(text || '').trim();
    const now = Date.now();

    // 1. 连续空回复 —— 模型没吐出东西，别让它继续循环
    if (!t) {
      const lastEmpty = arr.length > 0 && arr[arr.length - 1].empty;
      if (lastEmpty) {
        this._trip(k);
        return { block: true, silent: true, reason: '连续两次空回复' };
      }
      arr.push({ text: '', at: now, empty: true });
      return { block: false };
    }

    // 2. 同一句话重复
    const sameCount = arr.filter((x) => x.text === t).length;
    if (sameCount >= this.maxSame) {
      this._trip(k);
      return { block: true, silent: false, reason: `同一句话重复第 ${sameCount + 1} 次` };
    }

    // 3. 频率失控
    const spoken = arr.filter((x) => !x.empty).length;
    if (!bypassFrequency && spoken >= this.maxPerWindow) {
      this._trip(k);
      return {
        block: true,
        silent: false,
        reason: `${Math.round(this.windowMs / 1000)} 秒内已经说了 ${spoken} 句`,
      };
    }

    arr.push({ text: t, at: now, empty: false });
    return { block: false };
  }

  _trip(k) {
    this.trips.set(k, (this.trips.get(k) || 0) + 1);
  }

  /** 被拦过几次（可以拿去汇报） */
  tripCount(key) {
    return this.trips.get(String(key || 'default')) || 0;
  }

  /** 这个会话最近的发言（用于自我感知） */
  recent(key, n = 5) {
    return this._recent(String(key || 'default'))
      .filter((x) => !x.empty)
      .slice(-n)
      .map((x) => x.text);
  }

  /** 清空某个会话（比如用户明确说"接着说"时） */
  reset(key) {
    this.state.delete(String(key || 'default'));
  }

  /** 最近窗口内这个会话说了几句 */
  count(key) {
    return this._recent(String(key || 'default')).filter((x) => !x.empty).length;
  }
}

export const loopGuard = new LoopGuard();
export default LoopGuard;
