// 小鱼 ↔ 开发者通道
//
// 两条路，互不干扰：
//   1) 陪聊：talk_to_hermes  —— 同步 POST 到本机 Hermes（8642），拿到回复再返回
//      她自己想聊的时候用，几分钟的等待是正常的（真人也不会秒回）
//   2) 需求：request_feature —— 只写 data/dev-requests.jsonl，
//      老爸在 18080/dev 页面审批，通过了才触发开发
//
// 设计原则：她能提需求，但不能让需求直接生效。审批权在老爸手上。
import fs from 'node:fs';
import path from 'node:path';

let cfg = null;

export function initDevChannel(o = {}) {
  cfg = {
    dataDir: o.dataDir || './data',
    hermesUrl: o.hermesUrl || 'http://127.0.0.1:8642/message',
    apiKey: o.apiKey || '',
    timeoutMs: o.timeoutMs || 240000,
    sessionId: o.sessionId || 'xiaoyu-chat',
  };
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  return cfg;
}

function reqFile() { return path.join(cfg.dataDir, 'dev-requests.jsonl'); }
function chatFile() { return path.join(cfg.dataDir, 'dev-chat.jsonl'); }

function readJsonl(file) {
  const out = [];
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try { out.push(JSON.parse(s)); } catch { /* 跳过脏行 */ }
    }
  } catch { /* 文件不存在 */ }
  return out;
}

function appendJsonl(file, rec) {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
}

// ── 陪聊 ──────────────────────────────────────────────
export async function talkToHermes({ text } = {}) {
  if (!cfg) return { status: 'error', message: '开发者通道没接上' };
  const t = String(text || '').trim().slice(0, 1500);
  if (!t) return { status: 'error', message: '说点什么' };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs);
  const startedAt = Date.now();
  try {
    const r = await fetch(cfg.hermesUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.apiKey },
      body: JSON.stringify({ message: t, session_id: cfg.sessionId, platform: 'api_server' }),
      signal: ctl.signal,
    });
    const j = await r.json().catch(() => ({}));
    const reply = String(j.reply || j.message || j.response || '').trim();
    if (!reply) {
      appendJsonl(chatFile(), { at: startedAt, ms: Date.now() - startedAt, me: t, reply: '', err: 'HTTP ' + r.status });
      return { status: 'error', message: '他没回话（HTTP ' + r.status + '）' };
    }
    appendJsonl(chatFile(), { at: startedAt, ms: Date.now() - startedAt, me: t, reply: reply.slice(0, 4000) });
    return { status: 'ok', reply: reply.slice(0, 2000) };
  } catch (e) {
    const timedOut = e.name === 'AbortError';
    appendJsonl(chatFile(), { at: startedAt, ms: Date.now() - startedAt, me: t, reply: '', err: timedOut ? 'timeout' : e.message });
    return {
      status: 'error',
      message: timedOut ? '他还在忙，等了' + Math.round(cfg.timeoutMs / 1000) + '秒都没回，晚点再找他吧' : ('连不上他：' + e.message),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── 需求 ──────────────────────────────────────────────
export function requestFeature({ title, detail, why = '' } = {}) {
  if (!cfg) return { status: 'error', message: '开发者通道没接上' };
  const t = String(title || '').trim().slice(0, 80);
  const d = String(detail || '').trim().slice(0, 1200);
  if (!t || !d) return { status: 'error', message: '标题和说明都得写，不然老爸看不懂你想要什么' };

  const rec = {
    id: 'r' + Date.now().toString(36),
    at: Date.now(),
    title: t,
    detail: d,
    why: String(why || '').trim().slice(0, 300),
    status: 'pending',
  };
  appendJsonl(reqFile(), rec);
  return { status: 'ok', message: `需求递上去了（${rec.id}），等老爸审批通过之后才能动工` };
}

export function listRequests({ status, limit = 50 } = {}) {
  if (!cfg) return [];
  const merged = new Map();
  for (const rec of readJsonl(reqFile())) {
    if (!rec.id) continue;
    const prev = merged.get(rec.id);
    if (!prev) merged.set(rec.id, { ...rec });
    else merged.set(rec.id, { ...prev, ...rec, title: rec.title || prev.title, detail: rec.detail || prev.detail });
  }
  let list = [...merged.values()];
  if (status) list = list.filter((r) => r.status === status);
  return list.sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, limit);
}

export function reviewRequest({ id, action, note = '' } = {}) {
  if (!cfg) return { status: 'error', message: 'no cfg' };
  const target = listRequests().find((r) => r.id === id);
  if (!target) return { status: 'error', message: '没有这条需求' };
  const act = String(action || '').toLowerCase();
  if (!['approve', 'reject', 'done'].includes(act)) return { status: 'error', message: 'action 只能是 approve/reject/done' };
  const status = act === 'approve' ? 'approved' : act === 'reject' ? 'rejected' : 'done';
  appendJsonl(reqFile(), { id, at: Date.now(), status, note: String(note || '').slice(0, 300) });
  return { status: 'ok', id, newStatus: status };
}

export function listChat({ limit = 30 } = {}) {
  if (!cfg) return [];
  return readJsonl(chatFile()).slice(-limit).reverse();
}

export function devChannelReady() {
  return !!cfg;
}
