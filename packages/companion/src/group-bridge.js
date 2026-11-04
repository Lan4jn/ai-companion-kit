// 跨会话桥：读群聊（只读）+ 队列式发群消息（写），两条链路互不依赖。
//
// 读：read_group_chat  —— 直接问 NapCat 要历史消息，查不到就返回空，不写任何状态
// 写：queue_group_message —— 只入队；真正发送由 startOutboxWorker 后台按节奏出队
//
// 这样她"能去群里看、能去群里说"，但说不出格：白名单群、每日上限、随机间隔。
import fs from 'node:fs';
import path from 'node:path';

let bridge = null;
let currentChat = '';

/** 当前轮次正在说话的会话（group:xxx / private:xxx），用于防止在当前群里重复发言 */
export function setCurrentChat(key) {
  currentChat = String(key || '');
}

export function initGroupBridge({ bot, human = null, dataDir = './data', limits = {} } = {}) {
  bridge = {
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
    bridge.sentToday = j.sentToday || {};
    bridge.dayKey = j.dayKey || todayKey();
  } catch (e) {
    console.warn('[群桥] 队列读取失败：' + e.message);
  }
}

function saveQueue() {
  try {
    fs.mkdirSync(bridge.dataDir, { recursive: true });
    fs.writeFileSync(queueFile(), JSON.stringify({
      pending: bridge.queue,
      sentToday: bridge.sentToday,
      dayKey: bridge.dayKey,
    }, null, 1));
  } catch (e) {
    console.warn('[群桥] 队列写入失败：' + e.message);
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
      const lines = msgs.slice(-n).map((m) => {
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
      errors.push(`${gid}: ${e.message}`);
    }
  }

  if (!blocks.length) {
    return { status: 'ok', message: '群里最近没什么动静' + (errors.length ? `（${errors.join('；')}）` : '') };
  }
  return { status: 'ok', message: blocks.join('\n\n') };
}

/** 写群消息：只入队，不立即发送 */
export function enqueueGroupMessage({ groupId, text, atQq } = {}) {
  if (!bridge) return { status: 'error', message: '群桥未初始化' };
  const gid = String(groupId || '').trim();
  const body = String(text || '').trim().slice(0, 200);
  if (!gid || !body) return { status: 'error', message: '群号或内容为空' };
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
  bridge.cmdWindowCount += 1;

  const at = atQq ? `[CQ:at,qq=${String(atQq).replace(/\D/g, '')}] ` : '';
  bridge.queue.push({ gid, text: at + body, queuedAt: Date.now() });
  saveQueue();
  return {
    status: 'ok',
    message: `已排在队里，过一会儿会发到群 ${gid}（前面还有 ${bridge.queue.length - 1} 条）`,
  };
}

/** 后台出队：随机间隔 + 每群每日上限 */
export function startOutboxWorker() {
  if (!bridge || bridge.timer) return;
  bridge.timer = setInterval(() => { tick().catch(() => {}); }, 3000);
  tick().catch(() => {});
  console.log(`[群桥] 出队服务已启动（单次命令 ≤${bridge.limits.maxPerCommand} 条，每日兜底 ${bridge.limits.dailyPerGroup} 条/群）`);
}

async function tick() {
  if (!bridge || !bridge.queue.length) return;

  const k = todayKey();
  if (bridge.dayKey !== k) {
    bridge.dayKey = k;
    bridge.sentToday = {};
    saveQueue();
  }

  const now = Date.now();
  if (now < bridge.nextAt) return;

  const item = bridge.queue[0];
  const sent = bridge.sentToday[item.gid] || 0;
  if (sent >= bridge.limits.dailyPerGroup) {
    bridge.queue.shift();
    saveQueue();
    console.log(`[群桥] 群 ${item.gid} 今日额度已满，丢弃 1 条`);
    return;
  }

  bridge.queue.shift();
  const key = `group:${item.gid}`;
  try {
    if (bridge.human) {
      // 复用项目自带发送器：拆气泡、打字停顿、拟人节奏
      const r = await bridge.human.say(item.text, {
        setTyping: (on) => bridge.bot.setTyping(key, on),
        send: (m) => bridge.bot.send(key, m),
      });
      console.log(`[群桥] 已发到群 ${item.gid}（${r.sent} 条）：${item.text.slice(0, 40)}`);
    } else {
      const r = await bridge.bot.send(key, item.text);
      console.log(`[群桥] 已发到群 ${item.gid}：${item.text.slice(0, 40)}`);
      if (r && r.ok === false) console.warn('[群桥] 发送返回失败：' + (r.error || 'unknown'));
    }
    bridge.sentToday[item.gid] = sent + 1;
  } catch (e) {
    console.warn('[群桥] 发送异常：' + e.message);
  }

  const gap = bridge.limits.minGapMs + Math.random() * Math.max(0, bridge.limits.maxGapMs - bridge.limits.minGapMs);
  bridge.nextAt = Date.now() + gap;
  saveQueue();
}

export function getOutboxStatus() {
  if (!bridge) return { status: 'error', message: '群桥未初始化' };
  return {
    status: 'ok',
    pending: bridge.queue.length,
    sentToday: { ...bridge.sentToday },
    groups: [...bridge.bot.groupMembers.keys()],
  };
}
