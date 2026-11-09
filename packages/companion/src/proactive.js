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

let timer = null;
let running = false;
let ctx = null;
let lastSpokeAt = 0;

function inActiveHours(h, start, end) {
  if (start === end) return true;
  if (start < end) return h >= start && h < end;
  return h >= start || h < end;
}

function pickGap(minGapMs, maxGapMs) {
  return minGapMs + Math.random() * Math.max(1, maxGapMs - minGapMs);
}

async function thinkOnce() {
  const { brain, memory, bot, human, ownerId, key, minGapMs } = ctx;

  // 1. 检查真实私聊记录：如果最近 minGapMs 内刚刚聊过天，坚决不打扰！
  try {
    const recentTurns = memory.sessionTurns ? memory.sessionTurns(key, 1) : [];
    if (recentTurns.length > 0) {
      const lastTurnTime = recentTurns[recentTurns.length - 1].t;
      if (lastTurnTime && (Date.now() - lastTurnTime < (minGapMs || 45 * 60e3))) {
        const passedMins = Math.round((Date.now() - lastTurnTime) / 60000);
        console.log(`[主动] 刚刚 ${passedMins} 分钟前才跟老爸聊过天，不主动打扰`);
        return;
      }
    }
  } catch (e) {}

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const timeStr = `${now.getMonth() + 1}月${now.getDate()}日 ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const minutesSince = lastSpokeAt ? Math.round((Date.now() - lastSpokeAt) / 60000) : null;

  let diaryLine = '';
  try {
    const d = memory.renderDiary ? memory.renderDiary(3) : '';
    if (d) diaryLine = `你最近在忙的事：\n${String(d).slice(0, 400)}\n\n`;
  } catch (e) {}

  const isOwnerBusy = Boolean(globalThis.__xiaoyu_owner_busy_until && Date.now() < globalThis.__xiaoyu_owner_busy_until);
  const ownerBusyReason = globalThis.__xiaoyu_owner_busy_reason || '工作/开会';

  const busyDecisionBlock = isOwnerBusy
    ? `【重要背景：老爸当前正在忙工作】（前不久老爸说：“${ownerBusyReason}”）。\n` +
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
      record: false,
    });
  } catch (e) {
    console.log('[主动] 想的时候出错了: ' + (e?.message || e));
    return;
  }

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
  const text = String(j.text).trim().slice(0, 150);
  if (!text) return;

  // 1. 如果主动找阿姨
  if (target === 'aunt') {
    console.log(`[主动] 🧠 小鱼主动去找阿姨聊两句！原因: "${j.why || '无聊或想找阿姨'}" 内容: "${text}"`);
    try {
      const res = await callAunt({
        message: text,
        situation: j.why || (isOwnerBusy ? '老爸在忙工作，小鱼在房里无聊主动找阿姨' : '小鱼一个人待着主动找阿姨')
      });
      if (res && res.reply) {
        console.log(`[主动] 阿姨回复了小鱼：${res.reply.slice(0, 60)}...`);
        if (memory && typeof memory.logDiary === 'function') {
          memory.logDiary({
            category: '闲聊',
            activity: '主动找阿姨聊天',
            details: text,
            mood: '老爸在忙，跑去找阿姨唠嗑了'
          });
        }
      }
    } catch (e) {
      console.warn('[主动] 找阿姨失败:', e.message);
    }
    return;
  }

  // 2. 如果主动找老爸，但老爸在忙
  if (isOwnerBusy) {
    console.log(`[主动] 老爸正在忙（${ownerBusyReason}），体贴小鱼不打扰老爸`);
    return;
  }

  const gate = loopGuard.check(key, text);
  if (gate.block) {
    console.log(`[主动] 被守卫拦下：${gate.reason}`);
    return;
  }

  try {
    if (human && typeof human.say === 'function') {
      await human.say(text, {
        setTyping: (on) => bot.setTyping ? bot.setTyping(key, on) : null,
        send: (m) => bot.send(key, m),
      });
    } else {
      await bot.send(key, text);
    }
    lastSpokeAt = Date.now();
    console.log(`[主动] 主动找老爸：${text.slice(0, 50)}`);
    try {
      memory.logTurn({ where: key, who: '小鱼', text, reply: '' });
    } catch (e) {}
  } catch (e) {
    console.log('[主动] 发送失败: ' + (e?.message || e));
  }
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
  minGapMs = 45 * 60e3,
  maxGapMs = 160 * 60e3,
  activeStart = 8,
  activeEnd = 1,
  dailyMax = 4,
  initialDelayMs = 6 * 60e3,
} = {}) {
  if (running) return;
  if (!brain || !memory || !bot || !ownerId) {
    console.log('[主动] 参数不全，没启动');
    return;
  }

  running = true;
  ctx = { brain, memory, bot, human, ownerId: String(ownerId), key: `private:${ownerId}`, minGapMs };

  let dayKey = '';
  let dayCount = 0;

  const loop = async () => {
    if (!running) return;
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    if (dayKey !== today) {
      dayKey = today;
      dayCount = 0;
    }

    // 不设死板作息与上限，小鱼想说就说，不想说就安静待着
    if (dailyMax > 0 && dayCount >= dailyMax) {
      console.log(`[主动] 今天已经主动找过 ${dayCount} 次，先歇会儿`);
      if (running) timer = setTimeout(loop, 60 * 60e3);
      return;
    }

    const before = lastSpokeAt;
    await thinkOnce();
    if (lastSpokeAt !== before) dayCount += 1;

    if (!running) return;
    const gap = pickGap(minGapMs, maxGapMs);
    timer = setTimeout(loop, gap);
  };

  timer = setTimeout(loop, Math.max(0, Number(initialDelayMs) || 0));
  console.log(
    `[主动] 小鱼自主交流系统已启动（无死板作息与上限，想说就说、想安静就安静）`
  );
}

export function stopProactive() {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
}

export function getProactiveStatus() {
  return { running, lastSpokeAt: lastSpokeAt ? new Date(lastSpokeAt).toISOString() : null };
}

export default { startProactive, stopProactive, getProactiveStatus };
