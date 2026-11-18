/**
 * 主动找老爸。
 *
 * 不是定时播报，也不是"每隔 N 分钟必须说一句"。
 * 每隔一段时间她自己想一想：这会儿有没有话想跟老爸说。
 * 大多数时候答案应该是不想说 —— 那就不发。
 *
 * 发送前过一遍 loopGuard，防的是"卡在某个模式里反复找人"。
 */
import { loopGuard } from './loop-guard.js';
import { callAunt } from './dev-channel.js';
import { hasFishCliche } from './fish-cliche.js';
import { safeReplyParts } from './chat-concise-delivery.js';

let timer = null;
let running = false;
let ctx = null;
let lastSpokeAt = 0;
let generation = 0;
let active = null;
let stopping = null;

function inActiveHours(h, start, end) {
  if (start === end) return true;
  if (start < end) return h >= start && h < end;
  return h >= start || h < end;
}

function pickGap(minGapMs, maxGapMs) {
  return minGapMs + Math.random() * Math.max(1, maxGapMs - minGapMs);
}

async function thinkOnce(context, isCurrent) {
  const { brain, memory, bot, human, ownerId, key, minGapMs } = context;

  // 1. 检查真实私聊记录：如果最近 minGapMs 内刚刚聊过天，坚决不打扰！
  try {
    const recentTurns = memory.sessionTurns ? memory.sessionTurns(key, 1) : [];
    const lastTurnTime = Math.max(Number(memory.sessionLastActivity?.(key)) || 0, Number(recentTurns[recentTurns.length - 1]?.t) || 0);
    if (lastTurnTime && (Date.now() - lastTurnTime < (minGapMs || 45 * 60e3))) {
      const passedMins = Math.round((Date.now() - lastTurnTime) / 60000);
      console.log(`[主动] 刚刚 ${passedMins} 分钟前才跟老爸聊过天，不主动打扰`);
      return;
    }
  } catch (e) {}

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const timeStr = `${now.getMonth() + 1}月${now.getDate()}日 ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const minutesSince = lastSpokeAt ? Math.round((Date.now() - lastSpokeAt) / 60000) : null;

  // Never load shared diary/history. Scoped web evidence is optional; if its
  // verification fails we proceed without it, never with an unverified fallback.
  let webSnapshot;
  try { webSnapshot = await context.webContext?.snapshot(); } catch { webSnapshot = undefined; }
  const diaryLine = webSnapshot?.text ? `${webSnapshot.text}\n\n` : '';

  const isOwnerBusy = Boolean(globalThis.__xiaoyu_owner_busy_until && Date.now() < globalThis.__xiaoyu_owner_busy_until);

  const busyDecisionBlock = isOwnerBusy
    ? `【重要背景：老爸当前正在忙工作】。\n` +
      `老爸在忙的时候体贴懂事，绝对不要去 QQ 私聊发消息打扰他！\n` +
      `但老爸交代过：如果你一个人在房里觉得无聊、遇到什么搞不定的困难、或者想找人聊两句，你可以找家里的全能大管家「阿姨」（Hermes）！\n\n` +
      `请做出选择（只输出 JSON）：\n` +
      `- 找阿姨聊两句/求助：{"want": true, "target": "aunt", "text": "你想对阿姨说的话，10~50字随性口语", "why": "为什么找阿姨"}\n` +
      `- 不想找任何人，继续自己发呆放空或摸鱼：{"want": false}`
    : `想一想：这会儿有没有什么想跟家里人聊两句的？\n\n` +
      `真人平时的日常选择：\n` +
      `1. 找老爸聊两句：抛出由头、撒娇、分享搞笑视频、催添大白饭、问他在干嘛（“老爸”、“在忙不”、“好无聊啊啊啊”）。\n` +
      `2. 找阿姨聊两句：遇到搞不懂的问题、想问技术/网络事情、想出主意给老爸准备惊喜、或者老爸没空时找阿姨唠嗑吐槽。\n` +
      `3. 大部分时候是没什么特别想说的 —— 那就继续自己待着，绝不强行没话找话！\n\n` +
      `只输出 JSON：\n` +
      `- 不想找人：{"want": false}\n` +
      `- 找老爸：{"want": true, "target": "dad", "text": "随口发给老爸的一句，3~20字"}\n` +
      `- 找阿姨：{"want": true, "target": "aunt", "text": "想对阿姨说的一句话，10~50字", "why": "为什么找阿姨"}`;

  let out;
  try {
    out = await brain.reply({
      key: '__proactive__',
      userId: ownerId,
      userName: '自己',
      text:
        `现在是 ${timeStr}。\n\n` +
        diaryLine +
        (minutesSince !== null ? `上一次你主动找老爸说话是 ${minutesSince} 分钟前。\n\n` : '') +
        `你一个人在房里待着。\n` +
        busyDecisionBlock,
      images: [],
      situation: '你一个人待着，想想要不要找人说话',
      history: [],
      suppressLegacySessionRecall: true,
      tools: false,
      record: false,
    });
  } catch {
    console.log('[主动] stage=generation_error');
    return;
  }

  if (!isCurrent()) return;
  const raw = String(out?.text || '').trim();
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) {
    console.log('[主动] 没想清楚要不要说话，跳过');
    return;
  }

  let j;
  try {
    j = JSON.parse(m[0]);
  } catch (e) {
    return;
  }

  if (!j.want || !j.text) {
    console.log('[主动] 这会儿没什么想说的，继续自己待着');
    return;
  }

  const target = String(j.target || 'dad').toLowerCase();
  const text = String(j.text).trim();
  // Check the whole draft before any humanized split or external call. A
  // per-packet transport guard cannot enforce the total across bubbles.
  if (!safeReplyParts([text])) return;
  if (hasFishCliche(text)) return;

  // 1. 如果主动找阿姨
  if (target === 'aunt') {
    // A draft conditioned on private evidence is private as a whole.
    if (webSnapshot?.text) return;
    console.log('[主动] stage=aunt_send');
    try {
      const res = await callAunt({
        message: text,
        situation: j.why || (isOwnerBusy ? '老爸在忙工作，小鱼在房里无聊主动找阿姨' : '小鱼一个人待着主动找阿姨')
      });
      if (res?.status !== 'ok') {
        console.warn('[主动] 阿姨通道未确认回复，投递状态未知，不重试');
        return { unknown: res?.outcome === 'unknown' };
      }
      if (res.reply) {
        console.log('[主动] stage=aunt_reply_confirmed');
        if (memory && typeof memory.logDiary === 'function') {
          memory.logDiary({
            category: '闲聊',
            activity: '主动找阿姨聊天',
            details: text,
            mood: '老爸在忙，跑去找阿姨唠嗑了'
          });
        }
      }
    } catch {
      console.warn('[主动] stage=aunt_delivery_unknown');
      return { unknown: true };
    }
    return;
  }

  // 2. 如果主动找老爸，但老爸在忙
  if (isOwnerBusy) {
    console.log('[主动] stage=owner_busy');
    return;
  }

  const gate = loopGuard.check(key, text);
  if (gate.block) {
    console.log('[主动] stage=guard_blocked');
    return;
  }

  const guardEntry = loopGuard.state.get(key)?.at(-1);
  const delivered = [];
  let unknown = false;
  let sending = false;
  const send = async (message) => {
    if (!isCurrent()) throw new Error('主动消息已停止');
    if (unknown || sending) throw new Error('发送结果未确认，禁止再次发送');
    if (!safeReplyParts([...delivered, message])) throw new Error('CONCISE_BLOCKED');
    sending = true;
    let result;
    try {
      const dispatch = () => { if (!isCurrent()) throw new Error('主动消息已停止'); return bot.send(key, message); };
      result = webSnapshot?.text ? await webSnapshot.send(dispatch) : await dispatch();
    }
    catch (e) { unknown = true; throw e; }
    finally { sending = false; }
    if (result?.outcome === 'unknown' || (result?.ok !== true && result?.outcome !== 'permanent' && result?.outcome !== 'retry') || (result?.ok === true && result?.outcome != null && result.outcome !== 'confirmed')) unknown = true;
    if (result?.ok !== true || result?.blocked === true || (result?.outcome != null && result.outcome !== 'confirmed')) {
      throw new Error(result?.error || result?.reason || '消息未发送');
    }
    delivered.push(message);
    return result;
  };

  try {
    if (human && typeof human.say === 'function') {
      await human.say(text, {
        setTyping: (on) => isCurrent() && bot.setTyping ? bot.setTyping(key, on) : null,
        send,
      });
    } else {
      await send(text);
    }
  } catch {
    console.log('[主动] stage=delivery_failed');
  }

  if (!delivered.length) {
    // check() 已预先入队；只撤销本次条目，避免误删并发消息。
    const entries = loopGuard.state.get(key);
    const index = entries?.indexOf(guardEntry) ?? -1;
    if (index >= 0 && !unknown) entries.splice(index, 1);
    if (unknown) console.warn('[主动] 发送结果未知，不重试');
    return { unknown };
  }

  lastSpokeAt = Date.now();
  const sentText = delivered.join('');
  console.log('[主动] stage=delivery_confirmed');
  try {
    // Shared legacy turns lack source lineage and cannot honor a later forget.
    if (!webSnapshot?.text) memory.logTurn({ where: key, who: '小鱼', text: sentText, reply: '' });
  } catch (e) {}
  return { unknown };
}

/**
 * 启动主动找你。
 * @param {object} opts
 * @param {object} opts.brain    Brain 实例
 * @param {object} opts.memory   Memory 实例
 * @param {object} opts.bot      OneBot 实例（要有 send(key, text)）
 * @param {object} [opts.human]  Humanizer 实例
 * @param {string} opts.ownerId  老爸的 QQ 号
 * @param {number} [opts.minGapMs]   两次"要不要说话"之间最短间隔
 * @param {number} [opts.maxGapMs]   最长间隔
 * @param {number} [opts.activeStart] 活跃开始小时（默认 8）
 * @param {number} [opts.activeEnd]   活跃结束小时（默认 1，跨午夜）
 * @param {number} [opts.dailyMax]    一天最多主动找几次（防失控，默认 4）
 */
export function startProactive({
  brain,
  memory,
  bot,
  human,
  ownerId,
  webContext,
  minGapMs = 45 * 60e3,
  maxGapMs = 160 * 60e3,
  activeStart = 8,
  activeEnd = 1,
  dailyMax = 4,
  initialDelayMs = 6 * 60e3,
} = {}) {
  if (running || active) return;
  if (!brain || !memory || !bot || !ownerId) {
    console.log('[主动] 参数不全，没启动');
    return;
  }

  running = true;
  ctx = { brain, memory, bot, human, webContext, ownerId: String(ownerId), key: `private:${ownerId}`, minGapMs };
  const context = ctx;
  const myGeneration = ++generation;
  const isCurrent = () => running && generation === myGeneration;

  let dayKey = '';
  let dayCount = 0;

  const loop = async () => {
    if (!isCurrent()) return;
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    if (dayKey !== today) {
      dayKey = today;
      dayCount = 0;
    }

    // 1点 ~ 9点之间绝对安静（不主动找老爸说话）
    if (!inActiveHours(now.getHours(), activeStart, activeEnd)) {
      if (isCurrent()) timer = setTimeout(run, 20 * 60e3);
      return;
    }

    // 不设死板上限，小鱼想说就说，不想说就安静待着
    if (dailyMax > 0 && dayCount >= dailyMax) {
      console.log(`[主动] 今天已经主动找过 ${dayCount} 次，先歇会儿`);
      if (isCurrent()) timer = setTimeout(run, 60 * 60e3);
      return;
    }

    const before = lastSpokeAt;
    const result = await thinkOnce(context, isCurrent);
    if (lastSpokeAt !== before) dayCount += 1;

    if (!isCurrent()) return result;
    const gap = pickGap(minGapMs, maxGapMs);
    timer = setTimeout(run, gap);
  };

  const run = () => {
    if (!isCurrent()) return;
    const work = loop();
    active = work;
    work.then(() => { if (active === work) active = null; }, () => { if (active === work) active = null; });
    return work;
  };
  timer = setTimeout(run, Math.max(0, Number(initialDelayMs) || 0));
  console.log(
    `[主动] 小鱼自主交流系统已启动（作息 ${activeStart}:00-${activeEnd}:00 活跃，1:00-9:00 静音，无死板次数上限）`
  );
}

export function stopProactive({ timeoutMs = 10000 } = {}) {
  running = false;
  generation++;
  if (timer) clearTimeout(timer);
  timer = null;
  if (stopping) return stopping;
  if (!active) return Promise.resolve();
  const work = active;
  const drain = new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('主动消息排空超时，投递状态未知')), Math.max(0, timeoutMs));
    work.then(result => {
      clearTimeout(deadline);
      if (result?.unknown) reject(new Error('主动消息投递状态未知'));
      else resolve();
    }, error => { clearTimeout(deadline); reject(error); });
  });
  stopping = drain;
  drain.then(() => { if (stopping === drain) stopping = null; }, () => { if (stopping === drain) stopping = null; });
  return drain;
}

export function getProactiveStatus() {
  return { running, lastSpokeAt: lastSpokeAt ? new Date(lastSpokeAt).toISOString() : null };
}

export default { startProactive, stopProactive, getProactiveStatus };
