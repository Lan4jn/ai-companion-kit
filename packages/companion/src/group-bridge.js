// 跨会话桥：读群聊（只读）+ 队列式发群消息（写），两条链路互不依赖。
//
// 读：read_group_chat  —— 直接问 NapCat 要历史消息，查不到就返回空，不写任何状态
// 写：queue_group_message —— 只入队；真正发送由 startOutboxWorker 后台按节奏出队
//
// 这样她"能去群里看、能去群里说"，但说不出格：白名单群、每日上限、随机间隔。
import fs from 'node:fs';
import { hasFishCliche } from './fish-cliche.js';
import { paragraphs, safeReplyParts } from './chat-concise-delivery.js';
import path from 'node:path';
import { createHash } from 'node:crypto';

let bridge = null;
let currentChat = '';

/** 当前轮次正在说话的会话（group:xxx / private:xxx），用于防止在当前群里重复发言 */
export function setCurrentChat(key) {
  currentChat = String(key || '');
}

export function initGroupBridge({ bot, human = null, dataDir = './data', limits = {}, historyFilter = null } = {}) {
  bridge = {
    historyFilter,
    bot,
    human,
    dataDir,
    limits: {
      maxPerCommand: limits.maxPerCommand ?? 2,
      commandWindowMs: limits.commandWindowMs ?? 60000,
      dailyPerGroup: limits.dailyPerGroup ?? 30,
      minGapMs: limits.minGapMs ?? 8000,
      maxGapMs: limits.maxGapMs ?? 18000,
      allowedGroups: Array.isArray(limits.allowedGroups) ? limits.allowedGroups.map(String) : null,
      readLimit: limits.readLimit ?? 30,
    },
    queue: [],
    sentToday: {},
    cmdWindowAt: 0,
    cmdWindowCount: 0,
    dayKey: '',
    nextAt: 0,
    timer: null,
    sending: false,
    storageFailed: false,
    lastAttemptGroup: null,
  };
  loadQueue();
  return bridge;
}

function queueFile() {
  return path.join(bridge.dataDir, 'outbox.json');
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function loadQueue() {
  try {
    if (!fs.existsSync(queueFile())) return;
    const j = JSON.parse(fs.readFileSync(queueFile(), 'utf8'));
    bridge.queue = Array.isArray(j.pending) ? j.pending : [];
    // 进程可能在发包后、确认落盘前退出；不能自动重发。
    for (const item of bridge.queue) if (item.deliveryState === 'inflight') item.deliveryState = 'unknown';
    bridge.sentToday = j.sentToday || {};
    bridge.dayKey = j.dayKey || todayKey();
    bridge.cmdWindowAt = j.cmdWindowAt || 0;
    bridge.cmdWindowCount = j.cmdWindowCount || 0;
    bridge.nextAt = j.nextAt || 0;
  } catch (e) {
    bridge.storageFailed = true;
    console.warn('[群桥] 队列读取失败：' + e.message);
  }
}

function saveQueue() {
  if (bridge.storageFailed) return false;
  const tmp = queueFile() + '.tmp';
  try {
    fs.mkdirSync(bridge.dataDir, { recursive: true });
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({
        pending: bridge.queue,
        sentToday: bridge.sentToday,
        dayKey: bridge.dayKey,
        cmdWindowAt: bridge.cmdWindowAt,
        cmdWindowCount: bridge.cmdWindowCount,
        nextAt: bridge.nextAt,
      }, null, 1));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, queueFile());
    const dir = fs.openSync(bridge.dataDir, 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    return true;
  } catch (e) {
    bridge.storageFailed = true;
    console.warn('[群桥] 队列写入失败，停止出队：' + e.message);
    return false;
  }
}

function allowed(gid) {
  const g = String(gid);
  if (bridge.limits.allowedGroups) return bridge.limits.allowedGroups.includes(g);
  return bridge.bot.groupMembers.has(g);
}

function displayName(m) {
  return m?.sender?.card || m?.sender?.nickname || String(m?.sender?.user_id || '?');
}

/** 读群聊：不传 groupId 就看她所在的所有群（最多 4 个），只返回最近若干条 */
export async function readGroupChat({ groupId = '', limit } = {}) {
  if (!bridge) return { status: 'error', message: '群桥未初始化' };
  const n = Math.min(Math.max(Number(limit) || bridge.limits.readLimit, 5), 50);
  const targets = groupId
    ? [String(groupId).trim()]
    : [...bridge.bot.groupMembers.keys()].slice(0, 4);

  const blocks = [];
  const errors = [];
  for (const gid of targets) {
    if (!gid || !allowed(gid)) { errors.push(`${gid}: 不在可读范围`); continue; }
    try {
      const res = await bridge.bot.api('get_group_msg_history', { group_id: Number(gid), count: n });
      const d = res?.data?.data ?? res?.data;
      const msgs = Array.isArray(d?.messages) ? d.messages : [];
      // A remote history response has no inherent forget authorization. Only
      // identified entries explicitly approved by a trusted scoped filter may pass.
      const candidates = msgs.slice(-n).filter(m => /^[1-9]\d*$/.test(String(m?.message_id ?? '')));
      if (typeof bridge.historyFilter !== 'function') throw Error('历史授权不可用');
      let timer;
      let approved;
      try {
        approved = await Promise.race([
          Promise.resolve().then(() => bridge.historyFilter(gid, candidates.map(m => String(m.message_id)))),
          new Promise((_, reject) => { timer = setTimeout(() => reject(Error('历史授权超时')), 1000); }),
        ]);
      } finally { clearTimeout(timer); }
      if (!Array.isArray(approved) || approved.some(i => !Number.isInteger(i) || i < 0 || i >= candidates.length) || new Set(approved).size !== approved.length) throw Error('历史授权无效');
      const allowedIndices = new Set(approved);
      const lines = candidates.filter((_, i) => allowedIndices.has(i)).map((m) => {
        const txt = String(m?.raw_message || '')
          .replace(/\[CQ:[^\]]+\]/g, '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 60);
        return txt ? `${displayName(m)}: ${txt}` : '';
      }).filter(Boolean);
      if (lines.length) blocks.push(`【群 ${gid}】\n${lines.join('\n')}`);
      else errors.push(`${gid}: 最近没人说话`);
    } catch (e) {
      errors.push(`${gid}: 历史读取或授权失败`);
    }
  }

  if (!blocks.length) {
    return { status: 'ok', message: '群里最近没什么动静' + (errors.length ? `（${errors.join('；')}）` : '') };
  }
  return { status: 'ok', message: blocks.join('\n\n') };
}

function acquireBridgeLock() {
  const lock = path.join(bridge.dataDir, 'turn-group.lock');
  try {
    fs.mkdirSync(bridge.dataDir, {recursive:true});
    fs.mkdirSync(lock, {mode:0o700});
    return lock;
  } catch { return null; }
}
function releaseBridgeLock(lock) {
  try { fs.rmdirSync(lock); } catch { bridge.storageFailed = true; }
}

// Synchronous user-turn delivery: a durable, exclusive tombstone is written
// before any network call. Never retry a reserved message, even after crash.
export async function sendTurnGroupMessage(options) {
  if (!bridge || bridge.bot !== options?.bot || bridge.storageFailed)
    return {status:'denied', message:'群消息未通过安全检查，未发送。'};
  // Fail closed across processes. A crash leaves the lock in place for manual
  // inspection; automatically stealing it could duplicate an in-flight send.
  const lock = acquireBridgeLock();
  if (!lock) return {status:'denied', message:'群消息正在处理或锁不可用，未发送。'};
  try {
    loadQueue();
    return await sendTurnGroupMessageLocked(options);
  } finally {
    releaseBridgeLock(lock);
  }
}

async function sendTurnGroupMessageLocked({bot, identity, groupId, text, dispatch}) {
  const gid = String(groupId || '');
  if (!bridge || bridge.bot !== bot || bridge.storageFailed || !/^[1-9]\d*$/.test(gid) || !Array.isArray(bridge.limits.allowedGroups) || !allowed(gid) || currentChat === `group:${gid}` ||
      typeof text !== 'string' || !text || !safeReplyParts([text]) || hasFishCliche(text) || /\[CQ:/i.test(text) ||
      typeof identity !== 'string' || !identity || typeof dispatch !== 'function')
    return {status:'denied', message:'群消息未通过安全检查，未发送。'};
  const now = Date.now(), day = todayKey();
  if (bridge.sending || bridge.queue.some(x => x.gid === gid) || now < bridge.nextAt)
    return {status:'denied', message:'目标群有待处理消息或发送间隔未到，未发送。'};
  if (bridge.dayKey !== day) { bridge.dayKey = day; bridge.sentToday = {}; }
  if ((bridge.sentToday[gid] || 0) >= bridge.limits.dailyPerGroup)
    return {status:'denied', message:'目标群今日额度已满，未发送。'};
  if (now - bridge.cmdWindowAt > bridge.limits.commandWindowMs) { bridge.cmdWindowAt = now; bridge.cmdWindowCount = 0; }
  if (bridge.cmdWindowCount >= bridge.limits.maxPerCommand)
    return {status:'denied', message:'群消息发送频率超限，未发送。'};
  const dir = path.join(bridge.dataDir, 'turn-group-reservations');
  const file = path.join(dir, createHash('sha256').update(identity).digest('hex'));
  let fd;
  try {
    fs.mkdirSync(dir, {recursive:true, mode:0o700});
    fd = fs.openSync(file, 'wx', 0o600);
    fs.writeFileSync(fd, 'reserved\n');
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    const d = fs.openSync(dir, 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); }
  } catch {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    // Includes duplicate, unreadable ledger and failed durability: no send.
    return {status:'unknown', message:'该请求已处理或无法确认状态，不会重发。'};
  }
  // Reserve rate quota durably even when delivery becomes ambiguous.
  bridge.cmdWindowCount++;
  bridge.sentToday[gid] = (bridge.sentToday[gid] || 0) + 1;
  bridge.nextAt = now + bridge.limits.maxGapMs;
  bridge.sending = true;
  if (!saveQueue()) { bridge.sending = false; return {status:'unknown', message:'发送状态无法持久化，不会重发。'}; }
  let result;
  try { result = await dispatch(() => bot.send(`group:${gid}`, text), [...text].length); }
  catch { result = {ok:false,outcome:'unknown'}; }
  finally { bridge.sending = false; }
  if (result?.ok !== true || result.blocked === true || (result.outcome != null && !['success','confirmed'].includes(result.outcome)))
    return {status:'unknown', message:'发送结果不确定，不会重发。'};
  return {status:'ok', message:'群消息已发送。'};
}

/** 写群消息：只入队，不立即发送 */
export function enqueueGroupMessage(options = {}) {
  if (!bridge || bridge.storageFailed) return {status:'error', message:'群桥不可用'};
  const lock = acquireBridgeLock();
  if (!lock) return {status:'error', message:'群桥正在处理或锁不可用'};
  try { loadQueue(); if (bridge.storageFailed) return {status:'error', message:'队列读取失败'}; return enqueueGroupMessageLocked(options); }
  finally { releaseBridgeLock(lock); }
}
function enqueueGroupMessageLocked({ groupId, text, atQq } = {}) {
  if (!bridge) return { status: 'error', message: '群桥未初始化' };
  const gid = String(groupId || '').trim();
  const body = String(text || '').trim();
  if (!gid || !body) return { status: 'error', message: '群号或内容为空' };
  if (Array.from(body).length > 50) return { status: 'error', message: '消息超出长度限制' };
  if (hasFishCliche(body)) return { status: 'error', message: '消息含有套话，请换一种自然说法' };
  if (!allowed(gid)) return { status: 'error', message: `我不能往群 ${gid} 发消息` };
  if (currentChat === `group:${gid}`) {
    return { status: 'error', message: '你现在就在这个群里说话，直接说就行，不用排队' };
  }

  // 按"一次命令"计数：60 秒内的连续入队算同一条命令，最多 maxPerCommand 条
  const now = Date.now();
  if (now - bridge.cmdWindowAt > bridge.limits.commandWindowMs) {
    bridge.cmdWindowAt = now;
    bridge.cmdWindowCount = 0;
  }
  if (bridge.cmdWindowCount >= bridge.limits.maxPerCommand) {
    return { status: 'error', message: `一句话顶多带 ${bridge.limits.maxPerCommand} 句，再说就成刷屏了，等会儿` };
  }
  const at = atQq ? `[CQ:at,qq=${String(atQq).replace(/\D/g, '')}] ` : '';
  if (Array.from(at + body).length > 50) return { status: 'error', message: '消息超出长度限制' };
  bridge.cmdWindowCount += 1;
  bridge.queue.push({ gid, text: at + body, queuedAt: Date.now() });
  if (!saveQueue()) return { status: 'error', message: '队列持久化失败，出队已停止' };
  return {
    status: 'ok',
    message: `已排在队里，过一会儿会发到群 ${gid}（前面还有 ${bridge.queue.length - 1} 条）`,
  };
}

export function stopOutboxWorker() {
  if (!bridge) return;
  clearInterval(bridge.timer);
  bridge.timer = null;
  return bridge.activeTick;
}

function runTick() {
  if (bridge.activeTick) return;
  const operation = tick();
  bridge.activeTick = operation;
  operation.finally(() => { if (bridge?.activeTick === operation) bridge.activeTick = null; }).catch(() => {});
}

/** 后台出队：随机间隔 + 每群每日上限 */
export function startOutboxWorker() {
  if (!bridge || bridge.timer) return;
  bridge.timer = setInterval(runTick, 3000);
  runTick();
  console.log(`[群桥] 出队服务已启动（单次命令 ≤${bridge.limits.maxPerCommand} 条，每日兜底 ${bridge.limits.dailyPerGroup} 条/群）`);
}

async function tick() {
  if (!bridge || bridge.sending || bridge.storageFailed) return;
  const lock = acquireBridgeLock();
  if (!lock) return;
  try {
    loadQueue();
    if (bridge.storageFailed) return;
    await tickLocked();
  } finally { releaseBridgeLock(lock); }
}
async function tickLocked() {
  if (!bridge || !bridge.queue.length || bridge.sending || bridge.storageFailed) return;

  const k = todayKey();
  if (bridge.dayKey !== k) {
    bridge.dayKey = k;
    bridge.sentToday = {};
    saveQueue();
  }

  const now = Date.now();
  if (now < bridge.nextAt) return;

  const blockedGroups = new Set();
  const eligible = [];
  for (let i = 0; i < bridge.queue.length; i++) {
    const entry = bridge.queue[i];
    if (blockedGroups.has(entry.gid)) continue;
    // Consider only each group's oldest entry, including its ordering barrier.
    blockedGroups.add(entry.gid);
    if (entry.deliveryState === 'unknown' || entry.deliveryState === 'permanent' || entry.deliveryState === 'inflight') continue;
    eligible.push(i);
  }
  const lastPosition = eligible.findIndex(i => bridge.queue[i].gid === bridge.lastAttemptGroup);
  const index = eligible.length ? eligible[(lastPosition + 1) % eligible.length] : -1;
  if (index < 0) return;
  const item = bridge.queue[index];
  const sent = bridge.sentToday[item.gid] || 0;
  if (item.deliveryState === 'confirmed') {
    bridge.queue.splice(index, 1);
    bridge.sentToday[item.gid] = sent + 1;
    saveQueue();
    return;
  }
  if (typeof item.text !== 'string' || Array.from(item.text).length > 50 || (Array.isArray(item.parts) && (item.parts.length > 3 || item.parts.some(part => typeof part !== 'string') || Array.from(item.parts.join('')).length > 50))) {
    bridge.queue.splice(index, 1);
    saveQueue();
    return;
  }
  if (hasFishCliche(item.text)) {
    // Only eligible, definitely-not-inflight work reaches here. Drop the unsent
    // remainder rather than poisoning the group's ordering barrier.
    bridge.queue.splice(index, 1);
    saveQueue();
    return;
  }
  if (sent >= bridge.limits.dailyPerGroup) {
    bridge.queue.splice(index, 1);
    saveQueue();
    console.log(`[群桥] 群 ${item.gid} 今日额度已满，丢弃 1 条`);
    return;
  }

  bridge.lastAttemptGroup = item.gid;
  bridge.sending = true;
  const key = `group:${item.gid}`;
  // 先持久化发送中；若进程中断或结果落盘失败，重启后视为未知。
  const sendPart = async (message) => {
    if (!safeReplyParts(item.parts) || message !== item.parts[0]) return { ok: false, blocked: true };
    item.deliveryState = 'inflight';
    if (!saveQueue()) throw new Error('无法持久化发送状态');
    let result;
    try { result = await bridge.bot.send(key, message); }
    catch (e) { result = { ok: false, outcome: 'unknown', error: String(e?.message || e) }; }
    const confirmed = result?.ok === true && result?.blocked !== true && (result?.outcome == null || result.outcome === 'confirmed');
    if (confirmed) {
      if (item.parts) item.parts.shift();
      item.confirmedParts = (item.confirmedParts || 0) + 1;
      item.deliveryState = !item.parts || !item.parts.length ? 'confirmed' : 'retry';
    } else {
      item.deliveryState = result?.blocked === true || (result?.ok === false && result?.outcome === 'permanent')
        ? 'permanent' : result?.ok === false && result?.outcome === 'retry' && !item.confirmedParts ? 'retry' : 'unknown';
    }
    if (!saveQueue()) throw new Error('无法持久化发送结果');
    return confirmed ? result : { ok: false, error: result?.error || result?.reason || '发送结果未知' };
  };
  try {
    if (!item.parts) {
      item.parts = paragraphs(item.text);
      if (!safeReplyParts(item.parts)) {
        bridge.queue.splice(index, 1);
        saveQueue();
        return;
      }
      if (!saveQueue()) throw new Error('无法持久化分段');
    }
    if (bridge.human) {
      const r = await bridge.human.say([...item.parts], {
        prepared: true,
        setTyping: (on) => bridge.bot.setTyping(key, on),
        send: sendPart,
      });
      if (r.ok === false) throw new Error(r.error || '发送返回失败');
      if (item.parts.length) throw new Error('仍有未发送的消息');
    } else {
      while (item.parts.length) {
        const r = await sendPart(item.parts[0]);
        if (r.ok === false) throw new Error(r.error || '发送返回失败');
      }
    }
    bridge.queue.splice(index, 1);
    bridge.sentToday[item.gid] = sent + 1;
    console.log('[群桥] 已发送 1 条');
  } catch (e) {
    console.warn('[群桥] 发送失败，保留队列');
  } finally {
    const gap = bridge.limits.minGapMs + Math.random() * Math.max(0, bridge.limits.maxGapMs - bridge.limits.minGapMs);
    bridge.nextAt = Date.now() + gap;
    bridge.sending = false;
    saveQueue();
  }
}

export function getOutboxStatus() {
  if (!bridge) return { status: 'error', message: '群桥未初始化' };
  return {
    status: 'ok',
    pending: bridge.queue.length,
    storageFailed: bridge.storageFailed,
    deliveryStates: bridge.queue.reduce((counts, item) => {
      const state = item.deliveryState || 'queued';
      counts[state] = (counts[state] || 0) + 1;
      return counts;
    }, {}),
    sentToday: { ...bridge.sentToday },
    groups: [...bridge.bot.groupMembers.keys()],
  };
}
