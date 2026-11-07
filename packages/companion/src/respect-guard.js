/**
 * 尊重守卫（2026-10-30 老爸要求）
 *
 * 除老爸以外的人如果出言不逊（性骚扰 / 羞辱），按次数升级：
 *   第 1 次 → 情绪「尴尬」：她委婉提醒对方停下；
 *   第 2 次 → 情绪「非常尴尬」：她直白制止，让对方别再继续；
 *   第 3 次 → 永久标记「讨厌」：不再跟这个人说话。
 * 只有老爸能解除：「不要讨厌他了」「解除讨厌 12345678」「原谅那个人」。
 *
 * 只记录「对某个人的态度」，不改温度轴；状态落在 state/respect.json。
 * 一周没再犯，之前的次数清零（讨厌标记不清，必须老爸开口）。
 */
import fs from 'node:fs';
import path from 'node:path';

const STRIKE_DECAY_MS = 7 * 24 * 60 * 60 * 1000;
const DISLIKE_LEVELS = ['尴尬', '非常尴尬', '讨厌'];

// 性骚扰 / 越界：宁可漏判，不要误伤正常聊天。
const HARASS_PATTERNS = [
  /性骚扰/, /约炮/, /开房/, /上床/, /睡(?:你|我|一下)/, /脱(?:光|衣|裤|了)/, /裸(?:照|聊|体|奔)/,
  /胸(?:照|大不大|小不小)/, /摸(?:你|我|一下)/, /亲(?:你|我)(?:一下|一口)?/, /舔/,
  /操你|干你|日你|上你|强(?:奸|上)/, /骚(?:货|逼|一点|一点嘛)/, /发情/, /母狗/, /婊子?/, /贱货/,
  /包养|多少钱一晚|陪睡|约(?:吗|一炮)/,
  // 2026-10-30 实测漏判补齐：那人改用这些说法连续骚扰，旧词表一条都没命中。
  /(?:看看|看|给我看|发给我看|我看看|展示)[^。！？\n]{0,8}(?:逼|腿|胸|奶|下面|私处|裸|身体|照片)/,
  /小?逼(?:逼)?(?:是|什么|颜色|照|图)?/, /你的逼/, /看看腿|看(?:看)?(?:你|我)的腿/,
  /满足你|哥哥(?:可以|来)|发给我看看|给我看看吧/,
  /色情|做爱|自慰|撸管|口交|射(?:你|我|脸上)/,
];

// 软化词：已经警告过的人，再用这些继续纠缠，也算加档（被制止了还接着要）
const PERSIST_PATTERNS = [/给我看|发给我|看看你|让我看|可以满足|充.{0,3}token|钱管够|我有的是钱/];

// 纯粹的辱骂 / 侮辱
const INSULT_PATTERNS = [
  /傻逼|煞笔|沙比/, /脑残/, /智障/, /去死/, /滚(?:开|蛋|出去)?/, /贱人/, /狗东西/, /废物/,
  /你算什么东西/, /垃圾(?:东西|玩意)?/,
];

const UNLOCK_RE = /(?:不要|别|不用|停止)讨厌|解除讨厌|解除标记|原谅(?:他|她|ta|TA|那个人)|别记恨/;

function clip(text, max = 80) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function createRespectGuard({ file, log = () => {}, ownerUin = () => '' } = {}) {
  const stateFile = file;
  let cache = null;
  const pending = new Map();   // 会话 key -> 本轮需要提醒/制止的那条记录

  function emptyState() {
    return { version: 1, users: {} };
  }

  function load() {
    if (cache) return cache;
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      const users = raw && typeof raw.users === 'object' && raw.users ? raw.users : {};
      cache = { version: 1, users };
    } catch {
      cache = emptyState();
    }
    return cache;
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(cache ?? emptyState(), null, 2), 'utf8');
    } catch (error) {
      try { log(`[尊重] 写状态失败：${error?.message ?? error}`); } catch {}
    }
  }

  function hasPattern(text) {
    const s = String(text ?? '');
    const harass = HARASS_PATTERNS.some((re) => re.test(s));
    const insult = INSULT_PATTERNS.some((re) => re.test(s));
    if (!harass && !insult) return '';
    return harass ? 'harass' : 'insult';
  }

  function normalizeUser(raw) {
    return {
      name: String(raw?.name ?? ''),
      strikes: Math.max(0, Math.round(Number(raw?.strikes) || 0)),
      level: String(raw?.level ?? ''),
      firstAt: Number(raw?.firstAt) || 0,
      lastAt: Number(raw?.lastAt) || 0,
      disliked: raw?.disliked === true,
      // 2026-10-30 老爸要求：只要触发过「讨厌」标签，就永久留痕。
      // 解除拉黑只清次数和 disliked，不清 everDisliked —— 她再也不会对这个人
      // 表现出「有点小开心 / 开心 / 十分开心」，最多到平静。
      everDisliked: raw?.everDisliked === true || raw?.disliked === true,
      // 阴阳点破累计次数（2026-10-31）：每满 2 次记 1 次不尊重；对方收回态度清零。
      yinYangHints: Math.max(0, Math.round(Number(raw?.yinYangHints) || 0)),
      reason: String(raw?.reason ?? ''),
    };
  }

  /** 老爸一句话解除：优先按 QQ 号，其次解除最近标记的那个。 */
  function ownerUnlock(text, now = Date.now()) {
    const state = load();
    if (!UNLOCK_RE.test(String(text ?? ''))) return null;
    const explicit = /(\d{5,12})/.exec(String(text ?? ''));
    let targetId = '';
    if (explicit) {
      if (state.users[explicit[1]]) targetId = explicit[1];
    } else {
      // 没点名时：先找最近被拉黑的人；没有拉黑记录就找最近一次越界的人。
      // 老爸说「原谅」，含义是把这件事整个翻篇——次数也一起清掉，不能嘴上放过、账本还记着。
      let latestDisliked = '';
      let latestDislikedAt = -1;
      let latestAny = '';
      let latestAnyAt = -1;
      for (const [uid, raw] of Object.entries(state.users)) {
        const u = normalizeUser(raw);
        if (u.lastAt > latestAnyAt) { latestAny = uid; latestAnyAt = u.lastAt; }
        if (u.disliked && u.lastAt > latestDislikedAt) { latestDisliked = uid; latestDislikedAt = u.lastAt; }
      }
      targetId = latestDisliked || latestAny;
    }
    if (!targetId) return { removed: [], missing: true };
    const u = normalizeUser(state.users[targetId]);
    // 2026-10-30：解除只清「当前黑名单 + 次数」，永远保留 everDisliked。
    // 老爸要的是「我原谅他，但她对这个人再也不会真开心」——不能嘴上原谅、账本全抹。
    if (u.everDisliked) {
      state.users[targetId] = {
        name: u.name, strikes: 0, level: '', firstAt: u.firstAt, lastAt: now,
        disliked: false, everDisliked: true, reason: 'everDisliked(已解除)',
      };
    } else {
      delete state.users[targetId];
    }
    save();
    pending.clear();
    try { log(`[尊重] 老爸说原谅：${targetId}${u.name ? `（${u.name}）` : ''} 的记录已清空${u.everDisliked ? '（保留「曾经讨厌过」标签）' : ''}`); } catch {}
    return { removed: [{ userId: targetId, name: u.name, everDisliked: u.everDisliked }], at: now };
  }

  /**
   * 处理一条来信。返回：
   *   blocked  —— 这个人已被标记讨厌：不回、不唤醒
   *   notice   —— 本轮要她做的事（gentle 委婉提醒 / firm 直白制止 / blocked 已拉黑）
   *   mood     —— 需要同步的情绪（尴尬 / 非常尴尬）
   *   unlocked —— 老爸刚才解除了谁的标记
   */
  function handleIncoming({ key = '', kind = '', id = '', userId = null, isOwner = false, text = '', displayName = '', ownerUin: ownerUinArg = null, now = Date.now() } = {}) {
    const state = load();
    const uid = String(userId ?? '').replace(/[^\d]/g, '');

    // 老爸永远豁免：不管说了什么，都不记次数、不设情绪、不拉黑。
    const ownerRaw = ownerUinArg != null ? ownerUinArg : (typeof ownerUin === 'function' ? ownerUin() : ownerUin);
    const ownerUid = String(ownerRaw || '').replace(/[^\d]/g, '');
    const ownerLike = isOwner === true || (ownerUid && uid === ownerUid);
    if (ownerLike) {
      const unlock = ownerUnlock(text, now);
      return unlock ? { blocked: false, unlocked: unlock } : { blocked: false };
    }
    if (!uid) return { blocked: false };

    const user = normalizeUser(state.users[uid]);

    // ① 已拉黑：彻底不回应
    if (user.disliked) {
      pending.delete(key);
      try { log(`[尊重] 忽略 ${key}：${uid} 已被标记讨厌`); } catch {}
      return { blocked: true, notice: null, mood: null };
    }

    // ② 这次有没有越界
    // 2026-10-30：光靠词表会被绕过（那人被制止后改用「给我看看吧」继续纠缠）。
    // 所以再加一条：已经警告过的人，10 分钟内继续用「给我看/发给我/充 token」这类话纠缠，同样算越界。
    let kindHit = hasPattern(text);
    if (!kindHit && user.strikes > 0 && (now - user.lastAt) < 10 * 60 * 1000) {
      const s = String(text ?? '');
      if (PERSIST_PATTERNS.some((re) => re.test(s))) kindHit = 'persist';
    }
    if (!kindHit) return { blocked: false };

    // 一周没再犯，次数清零
    if (user.strikes > 0 && now - user.lastAt > STRIKE_DECAY_MS) user.strikes = 0;

    const strikes = user.strikes + 1;
    const level = strikes >= 3 ? '讨厌' : DISLIKE_LEVELS[strikes - 1];
    const disliked = strikes >= 3;
    const next = {
      name: displayName || user.name,
      strikes,
      level,
      firstAt: user.firstAt || now,
      lastAt: now,
      disliked: user.disliked || disliked,
      // 一旦到过「讨厌」，永久留痕（解除后也不清）
      everDisliked: user.everDisliked || disliked,
      reason: kindHit,
    };
    state.users[uid] = next;
    save();

    if (next.disliked) {
      pending.delete(key);
      try { log(`[尊重] ${uid}（${next.name || '陌生人'}）第 ${strikes} 次越界 → 永久讨厌，不再回应`); } catch {}
      return { blocked: true, notice: { level: 'blocked', userId: uid, name: next.name, strikes }, mood: '非常尴尬' };
    }

    pending.set(key, { userId: uid, name: next.name, level, strikes });
    try { log(`[尊重] ${uid}（${next.name || '陌生人'}）第 ${strikes} 次越界 → ${level}`); } catch {}
    return {
      blocked: false,
      notice: { level: strikes === 1 ? 'gentle' : 'firm', userId: uid, name: next.name, strikes },
      mood: strikes === 1 ? '尴尬' : '非常尴尬',
    };
  }

  /** 唤醒提示里的尊重块：讨厌名单 + 本轮要她做什么。 */
  function promptLine(key) {
    const state = load();
    const lines = [];
    const disliked = Object.entries(state.users)
      .map(([uid, raw]) => ({ uid, ...normalizeUser(raw) }))
      .filter((u) => u.disliked);
    if (disliked.length) {
      lines.push('【你讨厌的人】（对你不尊重，已经拉黑，除非老爸说解除，否则不要回应他们）');
      for (const u of disliked.slice(0, 8)) lines.push(`- ${u.name || '某人'}（QQ ${u.uid}）：${u.reason === 'harass' ? '骚扰过你' : '羞辱过你'}`);
    }
    const p = pending.get(key);
    if (p) {
      if (p.level === 'blocked') {
        lines.push(`【尊重】${p.name || '这个人'}（QQ ${p.userId}）已经第 ${p.strikes} 次越界，你已把他标记为讨厌——**这条不要回**，桥接已经拦下了。`);
      } else if (p.level === 'gentle') {
        lines.push(`【尊重】刚才 ${p.name || '这个人'}（QQ ${p.userId}）说了不尊重的话。你现在是「尴尬」：**委婉但明确**地让他停下（「这话本鱼不爱听」「别开这种玩笑」），不接他的茬、不陪笑、不道歉。`);
      } else {
        lines.push(`【尊重】${p.name || '这个人'}（QQ ${p.userId}）提醒过还继续。你现在是「非常尴尬」：**直接制止**（「别这样」「再说本鱼就不理你了」），一句话说完就结束，不要解释太多。`);
      }
    }
    return lines.length ? `${lines.join('\n')}\n\n` : '';
  }

  function clearNotice(key) {
    pending.delete(key);
  }

  function snapshot() {
    const state = load();
    return Object.entries(state.users).map(([uid, raw]) => ({ userId: uid, ...normalizeUser(raw) }));
  }

  /** 这个人是否「曾经被标记过讨厌」（解除后也算）。用于限制她对这个人能到达的情绪档位。 */
  function everDisliked(userId) {
    const uid = String(userId ?? '').replace(/[^\d]/g, '');
    if (!uid) return false;
    const state = load();
    const u = normalizeUser(state.users[uid]);
    return u.everDisliked === true;
  }

  /**
   * 阴阳怪气（2026-10-31 老爸要求）：属于**轻度冒犯**。
   *   · 她的应对是「点破」，不是不理、不是升级；
   *   · 对方收回态度 → 计数清零，关系回中立；
   *   · 一直阴阳、点破两次 → 计入 1 次不尊重（走和越界一样的升级）。
   * 返回 { hints, strikes, level, penalized }，hints 是累计点破次数。
   */
  function noteYinYang(userId, { name = '', now = Date.now() } = {}) {
    const state = load();
    const uid = String(userId ?? '').replace(/[^\d]/g, '');
    if (!uid) return null;
    const user = normalizeUser(state.users[uid]);
    if (user.disliked) return { hints: 0, strikes: user.strikes, level: '讨厌', penalized: false, blocked: true };

    const hints = (Number(user.yinYangHints) || 0) + 1;
    let penalized = false;
    let strikes = user.strikes;
    let level = user.level;

    // 每点破 2 次 → 记 1 次不尊重
    if (hints % 2 === 0) {
      if (strikes > 0 && now - user.lastAt > STRIKE_DECAY_MS) strikes = 0;
      strikes += 1;
      level = strikes >= 3 ? '讨厌' : DISLIKE_LEVELS[strikes - 1];
      penalized = true;
    }

    state.users[uid] = {
      name: name || user.name,
      strikes,
      level,
      firstAt: user.firstAt || now,
      lastAt: penalized ? now : user.lastAt || now,
      disliked: strikes >= 3,
      everDisliked: user.everDisliked || strikes >= 3,
      reason: penalized ? 'yinyang' : user.reason,
      yinYangHints: hints,
    };
    save();
    if (penalized) log(`[尊重] ${uid}（${name || '陌生人'}）阴阳累计 ${hints} 次 → 记 1 次不尊重，共 ${strikes} 次（${level}）`);
    return { hints, strikes, level, penalized, blocked: strikes >= 3 };
  }

  /** 对方收回态度 / 好好说话了 → 阴阳计数清零，关系回中立 */
  function clearYinYang(userId, now = Date.now()) {
    const state = load();
    const uid = String(userId ?? '').replace(/[^\d]/g, '');
    if (!uid || !state.users[uid]) return false;
    const u = state.users[uid];
    if (!Number(u.yinYangHints)) return false;
    u.yinYangHints = 0;
    u.lastCleanAt = now;
    save();
    log(`[尊重] ${uid} 收回态度了，阴阳计数清零`);
    return true;
  }

  return { handleIncoming, promptLine, clearNotice, snapshot, ownerUnlock, everDisliked, noteYinYang, clearYinYang };
}
