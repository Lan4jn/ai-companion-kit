// Batches are isolated by sender; turns sharing a conversation run sequentially.
export class ChatBatchQueue {
  constructor({ waker, run, onFlush = () => {}, maxMessages = 1024, maxMessagesPerSession = Math.min(64, maxMessages), durable = false }) {
    // Never silently fall back to volatile storage for an explicit opt-in.
    if (durable !== false) throw new Error('durable chat queue unavailable: atomic batching and delivery integration not implemented');
    this.waker = waker;
    this.run = run;
    this.onFlush = onFlush;
    this.pending = new Map();
    this.chains = new Map();
    // session -> 失败时间戳：失败只隔离一段时间，不能永久把整个会话静音
    this.failed = new Map();
    this.failedTtlMs = 10 * 60 * 1000;
    this.undelivered = [];
    this.attemptTimes = new WeakMap();
    this.stopped = false;
    if (!Number.isSafeInteger(maxMessages) || maxMessages < 1) throw new Error('invalid queue capacity');
    this.maxMessages = maxMessages;
    if (!Number.isSafeInteger(maxMessagesPerSession) || maxMessagesPerSession < 1 || maxMessagesPerSession > maxMessages) throw new Error('invalid session capacity');
    this.maxMessagesPerSession = maxMessagesPerSession;
    this.sessionCounts = new Map();
    this.messageCount = 0;
  }
  add(key, msg, windowMs) {
    if (this.stopped) return false;
    if (this.messageCount >= this.maxMessages || (this.sessionCounts.get(msg.key) || 0) >= this.maxMessagesPerSession) {
      console.error('[合并消息] 队列容量限制，未接收新消息；需要人工排查');
      return false;
    }
    this.messageCount++;
    this.sessionCounts.set(msg.key, (this.sessionCounts.get(msg.key) || 0) + 1);
    clearTimeout(this.pending.get(key));
    const result = this.waker.batch(msg, key);
    if (result.ready) {
      this.pending.delete(key);
      this.onFlush(key);
      this.enqueue(result.batch);
    } else {
      this.pending.set(key, setTimeout(() => this.flush(key), windowMs));
    }
    return true;
  }
  flush(key) {
    clearTimeout(this.pending.get(key));
    this.pending.delete(key);
    this.onFlush(key);
    const items = this.waker.flush(key);
    if (items.length) this.enqueue(items);
  }
  release(items) {
    const session = items[0].key;
    this.messageCount -= items.length;
    const remaining = (this.sessionCounts.get(session) || 0) - items.length;
    if (remaining > 0) this.sessionCounts.set(session, remaining);
    else this.sessionCounts.delete(session);
  }
  async execute(items) {
    const session = items[0].key;
    const failedAt = this.failed.get(session);
    if (failedAt !== undefined) {
      if (Date.now() - failedAt < this.failedTtlMs) {
        console.error(`[合并消息] 会话 ${session} 处于失败隔离中，本轮跳过（还剩 ${Math.ceil((this.failedTtlMs - (Date.now() - failedAt)) / 1000)}s）`);
        this.undelivered.push(items); // 交给人工核实，不静默丢消息
        return;
      }
      this.failed.delete(session);
    }
    try {
      this.attemptTimes.set(items, new Date().toISOString());
      const result = await this.run(items);
      if (result?.ok === false && result.outcome === 'permanent' && result.sent === 0) {
        this.release(items);
        console.error('[合并消息] 已确认回复未发送；跳过此回合，不自动重试');
        return;
      }
      if (result?.ok === false) throw new Error('delivery failed or unconfirmed');
      this.release(items);
    } catch (error) {
      this.failed.set(session, Date.now());
      this.undelivered.push(items);
      console.error('[合并消息] 处理或投递失败，结果可能未知；不自动重试');
    }
  }
  enqueue(items) {
    const session = items[0].key;
    const previous = this.chains.get(session) || Promise.resolve();
    const task = previous.then(() => this.execute(items));
    this.chains.set(session, task);
    task.then(() => { if (this.chains.get(session) === task) this.chains.delete(session); });
  }
  // Reconciliation must verify the whole turn is safe to rerun, not merely
  // that its reply is absent: run() may have other side effects.
  resolveFailure(session, decision, {onAccepted = () => {}} = {}) {
    if (!['delivered', 'safe-to-retry'].includes(decision)) throw new Error('explicit reconciliation required');
    const failure = this.failed.has(session)
      ? this.undelivered.find(items => items[0].key === session)
      : undefined;
    if (!failure) return Promise.resolve(false);
    const previous = this.chains.get(session) || Promise.resolve();
    const task = previous.then(async () => {
      const held = this.undelivered.filter(items => items[0].key === session);
      if (!this.failed.has(session) || held[0] !== failure) return false;
      this.undelivered = this.undelivered.filter(items => items[0].key !== session);
      this.failed.delete(session);
      if (decision === 'delivered') this.release(failure);
      onAccepted();
      for (const items of decision === 'delivered' ? held.slice(1) : held) await this.execute(items);
      return true;
    });
    this.chains.set(session, task);
    task.then(() => { if (this.chains.get(session) === task) this.chains.delete(session); });
    return task;
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    for (const key of [...this.pending.keys()]) this.flush(key);
  }
  async drain() {
    await Promise.all([...this.chains.values()]);
    if (this.failed.size) throw new Error('chat batch delivery failed or unconfirmed');
  }
}
