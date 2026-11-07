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

  let out;
  try {
    out = await brain.reply({
      key: '__proactive__',
      userId: ownerId,
      userName: '自己',
      text:
        `现在是 ${timeStr}。\n\n` +
        diaryLine +
        (minutesSince !== null ? `上一次你主动找他说话是 ${minutesSince} 分钟前。\n\n` : '') +
        `你一个人在房里待着。\n` +
        `想一想：这会儿有没有什么想跟老爸聊两句的？\n\n` +
        `真人平时找人是怎么找的：\n` +
        `- 抛出一个互动、由头或分享：比如刚看到个好玩的视频想吐槽、求老爸给大铁盆添饭、问他在干嘛、或者随口喊他一声（“老爸”、“在忙不”、“好无聊啊啊啊”）。\n` +
        `- 绝不要机械汇报自己的生理/行为状态！严禁出现“零食吃完了，坐着发呆，有点无聊”、“我刚喝了水，现在在看手机”这种像 NPC 日志一样的冰冷自述！\n` +
        `- 大部分时候是没什么想说的 —— 那就别说。\n\n` +
        `别写成这样（写了就算失败）：\n` +
        `- 像电子宠物一样向空气汇报自己的动作和姿态（“XX做完了，坐着发呆，有点XX”）\n` +
        `- 客服式寒暄或硬塞 emoji\n\n` +
        `只输出 JSON：\n` +
        `- 不想：{"want": false}\n` +
        `- 想：{"want": true, "text": "随口发过去的一句，3~20字。要像真人在发消息，可以有由头，可以撒娇，可以用逗号分小短句"}`,
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
    console.log('[主动] 这会儿没什么想说的');
    return;
  }

  const text = String(j.text).trim().slice(0, 150);
  if (!text) return;

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

    if (!inActiveHours(now.getHours(), activeStart, activeEnd)) {
      if (running) timer = setTimeout(loop, 30 * 60e3);
      return;
    }

    if (dayCount >= dailyMax) {
      console.log(`[主动] 今天已经找过 ${dayCount} 次，先歇着`);
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
    `[主动] 已启动：${activeStart}:00-${activeEnd}:00 之间，每 ${Math.round(minGapMs / 60000)}~${Math.round(maxGapMs / 60000)} 分钟想一次，每天最多 ${dailyMax} 次`
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
