/**
 * memory-brain 客户端 —— 接 peterpoal134/memory-brain 的 memory-core
 *
 * 那个仓库的 AstrBot 插件版装不到小鱼身上（她是 Node 应用），
 * 但 memory-core 是独立的 HTTP 记忆服务，正好能给「只负责收发消息的桥」用。
 *
 * 用法（brain.js）：
 *   构建 system 前 recall 一次，把 block 拼进去
 *   回复后 remember 一条（只记值得记的，不是每句都写）
 *
 * 它的可见性：public 群里私聊都能召回 / private 只私聊 / group 只群聊
 */
const DEFAULT_TIMEOUT = 6000;

let cfg = null;
let ready = false;
let stats = { recalls: 0, remembers: 0, fails: 0 };

export function initMemoryBrain(c) {
  cfg = {
    enabled: Boolean(c?.enabled),
    baseUrl: String(c?.baseUrl || 'http://127.0.0.1:8780').replace(/\/+$/, ''),
    token: String(c?.token || ''),
    topK: Number(c?.topK || 4),
    maxBlockChars: Number(c?.maxBlockChars || 600),
  };
  ready = cfg.enabled && Boolean(cfg.baseUrl);
  if (ready) console.log(`[MemoryBrain] 已接入 ${cfg.baseUrl}`);
  else console.log('[MemoryBrain] 未启用');
  return ready;
}

const headers = () => ({
  'Content-Type': 'application/json',
  ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
});

async function call(path, body, timeoutMs = DEFAULT_TIMEOUT) {
  const res = await fetch(cfg.baseUrl + path, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const d = await res.json();
  if (d?.status && d.status !== 'ok') throw new Error(String(d.status));
  return d?.data ?? d;
}

/**
 * 召回记忆，返回能直接拼进 system 的文本块；没有就返回空串。
 * 失败一律吞掉——记忆挂了不能拖垮聊天。
 */
export async function recall(query, { isGroup = false, isOwner = false } = {}) {
  if (!ready || !String(query || '').trim()) return '';
  const visibility = isGroup ? ['public', 'group'] : (isOwner ? ['public', 'private'] : ['public', 'private']);
  try {
    const d = await call('/recall', { query: String(query).slice(0, 500), k: cfg.topK, visibility });
    stats.recalls += 1;
    let block = String(d?.block || '').trim();
    if (!block) return '';
    if (block.length > cfg.maxBlockChars) block = block.slice(0, cfg.maxBlockChars) + '…';
    return block;
  } catch (e) {
    stats.fails += 1;
    console.log('[MemoryBrain] recall 失败：' + (e?.message || e));
    return '';
  }
}

/** 写一条记忆；kind: event / fact / reflect / skill / lesson */
export async function remember(text, { kind = 'event', importance = 0.5, visibility = 'public' } = {}) {
  if (!ready) return null;
  const t = String(text || '').trim();
  if (t.length < 6) return null;   // 太短的没信息量，别占地方
  try {
    const d = await call('/remember', { text: t.slice(0, 800), kind, importance, visibility });
    stats.remembers += 1;
    return d;
  } catch (e) {
    stats.fails += 1;
    console.log('[MemoryBrain] remember 失败：' + (e?.message || e));
    return null;
  }
}

export function getMemoryBrainStats() {
  return { enabled: ready, baseUrl: cfg?.baseUrl || '', ...stats };
}
