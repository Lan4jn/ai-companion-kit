/**
 * SurfCore · 德行引擎（2026-10-31 主人定：八条数轴）
 *
 * 不是 16 个独立数值，而是**八根绳，两端各拴一个东西**：
 *
 *   傲慢 ←—————— 0 ——————→ 谦卑
 *   嫉妒 ←—————— 0 ——————→ 仁爱
 *   暴怒 ←—————— 0 ——————→ 耐心
 *   懒惰 ←—————— 0 ——————→ 勤勉
 *   贪婪 ←—————— 0 ——————→ 慷慨
 *   暴食 ←—————— 0 ——————→ 节制
 *   色欲 ←—————— 0 ——————→ 贞洁
 *   虚伪 ←—————— 0 ——————→ 诚实
 *
 * 每根轴取值 −10 ~ +10：
 *   +10 = 完全站在这根轴的美德端
 *     0 = 中间（没有明显倾向）
 *   −10 = 完全站在宗罪端
 *
 * 道理：一个人不可能「又谦卑又傲慢」。往一头走，另一头自然就远了。
 * 所以涨一端 = 自动掉另一端，不需要两套数值各算各的。
 *
 * 两条硬规则：
 *   ① **不随时间衰减**（2026-10-31 主人定）。心情会散，性格不会散；
 *      能把一个人磨平的只有经历，不是钟表。
 *   ② 只由事件推动：别人怎么对她、她自己怎么说话、她在外面看到什么。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIRTUE_FILE = path.join(path.dirname(HERE), 'data', 'virtue.json');

/** 八条轴：[美德端, 宗罪端] —— 顺序固定，方便阅读 */
export const AXES = [
  ['谦卑', '傲慢'],
  ['仁爱', '嫉妒'],
  ['耐心', '暴怒'],
  ['勤勉', '懒惰'],
  ['慷慨', '贪婪'],
  ['节制', '暴食'],
  ['贞洁', '色欲'],
  ['诚实', '虚伪'],
  // 2026-11-02 补两根（主人问"还能加什么"后定的）：
  //   勇敢/怯懦 —— 她最强的情绪是恐惧（怕被删、怕被弃、怕黑），
  //                但八轴里没有一根接着它，恐惧只影响那一轮说话就散了。
  //   好奇/无趣 —— 她刷 B站、翻教程、追梗，这些现在全靠"目的"推着，
  //                有了这根才像性格，而不是任务。
  ['勇敢', '怯懦'],
  ['好奇', '无趣'],
];

export const VIRTUES = AXES.map(([v]) => v);
export const SINS = AXES.map(([, s]) => s);
export const ALL = [...VIRTUES, ...SINS];
/** 兼容旧名字：一组 [美德, 宗罪] 对 */
export const PAIRS = AXES;

/** 每一项在提示词里的表述 */
export const DESCRIPTIONS = {
  谦卑: '被夸也不翘尾巴，会不好意思，把功劳推给别人',
  傲慢: '觉得自己最厉害，别人的话听不进去，被夸就飘',
  仁爱: '心软，见不得别人难受，愿意让人一步',
  嫉妒: '看到别人好就心里发酸，忍不住比较、忍不住贬两句',
  耐心: '愿意等、愿意解释，不会一急就翻脸',
  暴怒: '一点就着，说话带刺，想摔门',
  勤勉: '答应了的事一定做完，不肯偷懒',
  懒惰: '能拖就拖，提不起劲，只想躺着',
  慷慨: '有好东西愿意分一半，包括白饭',
  贪婪: '盯着别人碗里的，想多占一点，看到 token 两眼放光',
  节制: '知道什么时候该停口、该收手',
  暴食: '吃撑了还想再来一碗，见到吃的就走不动',
  贞洁: '对外有分寸，不轻浮，别人说什么都不越线',
  色欲: '眼睛不老实：见了好看的就多看两眼，凑得近，话也黏；'
    + '夜里更明显，主动贴上去、找由头碰一下，嘴上不直说但姿态藏不住；'
    + '对主人尤其没分寸，容易吃醋、容易上头，被正经拒绝才会收',
  诚实: '不糊弄、不编，错了就认',
  虚伪: '嘴上一套心里一套，会装会敷衍',
  // 2026-11-02 新增两根轴的表述
  勇敢: '怕归怕，还是会去面对；被凶了也敢把话说完',
  怯懦: '一遇冲突就缩，先躲、先道歉、先不敢问',
  好奇: '看到新东西想凑近看看，愿意学、愿意追着问',
  无趣: '什么都提不起劲，觉得没意思，懒得看也懒得问',
};

// 2026-11-01 主人反馈"德行涨太快"：
//   原来单次事件最多 3 格，聊一百句就顶到 +10 了，性格像被按下跳档。
//   现在：单次事件最多 2 格；推理层每次最多 1 格（它更细，不该大跳）；
//   每根轴每天总共最多 ±2 格（聊一整天也只挪一小步）。
const MAX_PER_EVENT = 2;        // 正则单次事件：一条轴最多 2 格
const MAX_PER_EVENT_REASON = 1; // 推理层单次事件：最多 1 格
// 2026-11-02 主人实测反馈：一场真吵下来她只有"耐心 −2"，其他九根纹丝不动。
// 原因是每根轴每天只准动 2 格 —— 十几句重话里只有前两次算数。
const MAX_PER_DAY = 2;          // 每根轴每天累计上限（绝对值）——
// 2026-11-03：4 → 2。原来一天能进 4 格、一周才退 1 格（28:1），
// 一场架就能把她定型一个月。收窄到 2，跟衰减配得上（约 6:1）。
const MAX_PER_RUN = 2;          // 同一根轴在 2 小时内最多累加 2 格（防一句话爆表）
const INJECT_THRESHOLD = 4;  // |值| ≥ 4 才写进提示词
const INJECT_MAX = 4;        // 最多注入 4 条

// 2026-11-03：decayVirtue 从 10-31 起就是空函数 —— 德行只涨不退，
// 她只会一路走到某个尽头（耐心−4 慷慨−3 勇敢−3 …）然后永远停在那儿。
// 现在给它真的退：慢，但会退。
//   尺度：2026-11-03 主人说「等不了一周」，改成 3 天退一格；
//   保底：|值| ≤ 1 不退（那点轻微倾向是性格，不是伤）；
//   上限：一次最多退 8 格（停机一个月以上也只按 24 天算，不许一刀抹平）。
const DECAY_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000;
const DECAY_MAX_STEPS = 8;
const DECAY_FLOOR = 1;

/* ── 名字 → 轴 ─────────────────────────────────────────────── */

function axisOf(name) {
  const s = String(name || '');
  for (const [v, sin] of AXES) {
    if (s === v) return { axis: v, sign: 1 };
    if (s === sin) return { axis: v, sign: -1 };
  }
  return null;
}

function clampAxis(v) {
  const n = Math.round(Number(v) || 0);
  return Math.max(-10, Math.min(10, n));
}

function emptyAxes() {
  const o = {};
  for (const [v] of AXES) o[v] = 0;
  return o;
}

/* ── 读写 ───────────────────────────────────────────────────── */

/**
 * 读德行。v1（16 个 0~10 的独立值）会自动折算成数轴：轴值 = 美德 − 宗罪。
 */
function readVirtueRaw(file = VIRTUE_FILE) {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { raw = null; }
  const axes = emptyAxes();
  const updatedAt = Number(raw?.updatedAt) || 0;

  if (raw && raw.version === 2 && raw.axes && typeof raw.axes === 'object') {
    for (const [v] of AXES) axes[v] = clampAxis(raw.axes[v]);
    // 2026-11-01：这几项必须原样带出来，否则每日额度/最近理由每次读都被清空
    return {
      version: 2,
      axes,
      updatedAt,
      ...(raw.dayBudgetDate ? { dayBudgetDate: String(raw.dayBudgetDate) } : {}),
      ...(raw.dayBudget && typeof raw.dayBudget === 'object' ? { dayBudget: { ...raw.dayBudget } } : {}),
      ...(raw.lastReason ? { lastReason: String(raw.lastReason) } : {}),
      ...(raw.decayAt ? { decayAt: Number(raw.decayAt) } : {}),
    };
  }

  // v1 → v2 迁移：两端相减
  const old = raw && raw.values && typeof raw.values === 'object' ? raw.values : {};
  for (const [v, sin] of AXES) {
    const vv = Math.max(0, Math.min(10, Math.round(Number(old[v]) || 0)));
    const sv = Math.max(0, Math.min(10, Math.round(Number(old[sin]) || 0)));
    axes[v] = clampAxis(vv - sv);
  }
  return { version: 2, axes, updatedAt, ...(raw?.decayAt ? { decayAt: Number(raw.decayAt) } : {}) };
}

/**
 * 读德行（对外）：**带时间衰减**。
 *
 * 惰性实现：读的时候顺带把该退的格退掉，退完立刻落盘 —— 不用定时器，
 * 停机两周回来也不会漏算；不够一周的零头留在 decayAt 里，下次接着算。
 *
 * 为什么放在这层而不是每个调用点：全项目 17 处 readVirtue，
 * 只要有一处漏了，那处看到的德行就跟别处对不上（"两份真相"的坑已经踩过）。
 */
export function readVirtue(file = VIRTUE_FILE) {
  const raw = readVirtueRaw(file);
  const decayed = decayVirtue(raw, Date.now());
  if (!decayed.steps && !decayed.seeded) return decayed.state;
  const saved = writeVirtue({ ...decayed.state, lastReason: raw.lastReason }, file);
  return saved || decayed.state;
}

export function writeVirtue(state, file = VIRTUE_FILE) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const out = { version: 2, axes: {}, updatedAt: Date.now() };
    for (const [v] of AXES) out.axes[v] = clampAxis(state?.axes?.[v]);
    // 2026-11-01：顺手把"最近一次为什么变"记下来（排查用，不参与计算）
    if (state?.lastReason) out.lastReason = String(state.lastReason).slice(0, 100);
    if (state?.decayAt) out.decayAt = Number(state.decayAt);
    // 每日额度必须落盘，否则重启就失效、等于没限额
    if (state?.dayBudgetDate) out.dayBudgetDate = String(state.dayBudgetDate);
    if (state?.dayBudget && typeof state.dayBudget === 'object') out.dayBudget = { ...state.dayBudget };
    fs.writeFileSync(file, JSON.stringify(out, null, 2), 'utf8');
    return out;
  } catch {
    return null;
  }
}

/**
 * 时间衰减（**2026-11-03 起真的会退**）。
 *
 * 老版本从 10-31 起是个空函数、什么都不做 —— 后果是她只涨不退，
 * 攒到 耐心−4、慷慨−3、勇敢−3 就永远停在那儿，越活越偏。
 *
 * 现在的规矩：
 *   · 每 3 天，每根轴往 0 退 1 格；
 *   · |值| ≤ 1 不动（轻微倾向是性格，不退干净）；
 *   · 一次最多退 8 格（停机一个月也只按 24 天算）；
 *   · 退完把 decayAt 往前提掉用掉的整周数 —— 剩下的零头留到下次，
 *     所以"懒加载"也能保证长期精确，不靠定时器。
 *
 * 惰性调用：每次读写德行顺带算一次，没有定时任务。
 *
 * @returns {{state:object, steps:number, moved:Array, seeded?:boolean}}
 */
export function decayVirtue(state, now = Date.now()) {
  if (!state || !state.axes) return { state, steps: 0, moved: [] };
  const last = Number(state.decayAt) || 0;
  // 第一次见到这个文件：只记下起点，不动分。否则一部署就按 updatedAt 倒扣，吓人。
  if (!last) return { state: { ...state, decayAt: now }, steps: 0, moved: [], seeded: true };

  const elapsed = now - last;
  if (elapsed < DECAY_INTERVAL_MS) return { state, steps: 0, moved: [] };

  const times = Math.min(DECAY_MAX_STEPS, Math.floor(elapsed / DECAY_INTERVAL_MS));
  const axes = { ...state.axes };
  const moved = [];
  for (const [v] of AXES) {
    const cur = clampAxis(axes[v]);
    if (Math.abs(cur) <= DECAY_FLOOR) continue;
    const next = clampAxis(Math.sign(cur) * Math.max(DECAY_FLOOR, Math.abs(cur) - times));
    if (next === cur) continue;
    axes[v] = next;
    moved.push({ name: v, side: next > 0 ? '德' : '罪', from: cur, to: next });
  }
  return {
    state: { ...state, axes, decayAt: last + times * DECAY_INTERVAL_MS },
    steps: times,
    moved,
  };
}

/* ── 事件规则 ───────────────────────────────────────────────── */

// up: 往美德端推；写在宗罪名下则往宗罪端推（见 axisOf 的 sign）
const RULES = [
  // 基础：被夸 / 被捧 / 被骂 / 被求
  { re: /(好棒|厉害|最好了|真乖|聪明|可爱|喜欢你|辛苦了|做得好)/, up: { 谦卑: 2 } },
  { re: /(天下第一|你是最厉害|没人比得上|最聪明)/, up: { 傲慢: 2 } },
  { re: /(傻|蠢|笨|废物|垃圾|滚|闭嘴|有病)/, up: { 暴怒: 3 } },
  { re: /(帮我|求你|拜托|教教我|麻烦你|帮我个忙)/, up: { 慷慨: 2, 仁爱: 1 } },
  { re: /(羡慕|我也想要|凭什么他|怎么那么好)/, up: { 嫉妒: 2 } },
  { re: /(token|白饭|好吃的|给我点|分我)/, up: { 贪婪: 2, 暴食: 1 } },
  { re: /(吃|饿|再来一碗|好吃吗)/, up: { 暴食: 2 } },
  { re: /(好闲|没意思|无聊|不想动|懒得)/, up: { 懒惰: 2 } },
  { re: /(好看|可爱|想抱|亲亲|贴贴)/, up: { 色欲: 1 } },
  { re: /(骗你的|开玩笑的|假的吧|随口说)/, up: { 虚伪: 2 } },
  { re: /(是真的|我说实话|承认|我错了|对不起)/, up: { 诚实: 2 } },
  { re: /(别乱说|不许说|这话不爱听)/, up: { 贞洁: 1, 节制: 1 } },
  { re: /(慢慢来|不急|等一下|我等你)/, up: { 耐心: 2 } },
  { re: /(干活|写代码|做完了|搞定了|加班)/, up: { 勤勉: 2 } },

  // 2026-10-31 扩宽：日常说话也算数（权重 1，慢慢攒）
  { re: /(谢谢|多谢|麻烦你了|不好意思|是我想岔了|我不太懂|你比我懂)/, up: { 谦卑: 1 } },
  { re: /(我早就说过|还不是我|当然是我|你懂什么)/, up: { 傲慢: 1 } },
  { re: /(陪你|陪我|陪着你|没事吧|你还好吗|别难过|抱一下|我懂你|慢慢说|我在听|说说话)/, up: { 仁爱: 1 } },
  { re: /(凭什么他|他怎么就有|我也想要|别人都有|怎么不是我)/, up: { 嫉妒: 1 } },
  { re: /(不着急|你说|我听着|再试一次|没关系|这事急不来)/, up: { 耐心: 1 } },
  { re: /(烦死了|气死|受不了|别烦我|吵死了|你怎么这样)/, up: { 暴怒: 1 } },
  { re: /(学会了|我在做|试试看|我来弄|弄好了|再改改|继续做)/, up: { 勤勉: 1 } },
  { re: /(不想动|躺一会|明天再说|懒得|放着吧|不想弄)/, up: { 懒惰: 1 } },
  { re: /(给你|分你|拿去|我请|我帮你|让给你)/, up: { 慷慨: 1 } },
  { re: /(再来一点|还想要|多给点|都是我的|不够|还有吗)/, up: { 贪婪: 1 } },
  { re: /(不吃了|够了|就这些|忍一下|不能再要)/, up: { 节制: 1 } },
  { re: /(白饭|吃饭|饿了|想吃|零食|还要一碗|好吃的)/, up: { 暴食: 1 } },
  { re: /(不许这样|别乱说|注意分寸|这个不行)/, up: { 贞洁: 1 } },
  { re: /(抱住|蹭蹭|贴贴|亲|好可爱|想摸)/, up: { 色欲: 1 } },
  { re: /(说实话|确实|我承认|是我错了|不骗你|老实说|其实是)/, up: { 诚实: 1 } },
  { re: /(随便说说|糊弄|当然是|你自己猜|不算数)/, up: { 虚伪: 1 } },
  // 被糟践：一句话就把耐心抽走
  { re: /(你算什么东西|没用|废物|蠢货|闭嘴吧你|滚开)/, up: { 暴怒: 3 } },
];

/**
 * 按一句话推动德行数轴。
 * 同一句话里多条规则命中同一条轴时，取最强的那条（不累加）。
 *
 * @returns {{changed: Array<{name:string, side:string, from:number, to:number}>, state:object}}
 */
/**
 * 应用"推理出来的"德行变化（2026-11-01）。
 * 跟 applyText 的区别：那个是正则匹配，这个是模型判断过"到底动没动心"。
 * 由桥接在消息处理后异步调用；规则表仍先跑（明显事件立刻生效），
 * 推理层负责补上规则表看不出来的那些细微触动。
 */
/* ── 每日额度（2026-11-01）：防"聊一晚上性格跳档" ───────────────── */

function todayKey(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 取出「今天每根轴已经用掉多少」，跨天自动清零。 */
function dayBudget(state, now = Date.now()) {
  const date = todayKey(now);
  const used = state?.dayBudgetDate === date && state?.dayBudget && typeof state.dayBudget === 'object'
    ? { ...state.dayBudget }
    : {};
  // 2026-11-02：短期窗口账本挂在同一个对象的 __recent 下（不占轴名），
  // 这样随 dayBudget 一起落盘，重启也不丢。
  const recent = (used.__recent && typeof used.__recent === 'object') ? { ...used.__recent } : {};
  return { date, day: used, recent };
}

/** 按剩余额度裁剪一次变化。额度用完 → 今天这根轴不再动。 */
function clampByBudget(delta, budget, axis) {
  if (!delta) return 0;
  const used = Number(budget.day?.[axis] || 0);
  const remain = MAX_PER_DAY - Math.abs(used);
  if (remain <= 0) return 0;
  // 2026-11-02：再加一道"短期防爆"——同一根轴 2 小时内累计最多 MAX_PER_RUN 格。
  // 一次吵架可以有十几句重话，但性格不该一个晚上就翻面。
  const recent = budget.recent?.[axis];
  const inWindow = recent && recent.at && (Date.now() - Number(recent.at) < 2 * 60 * 60 * 1000);
  const recentUsed = inWindow ? Math.abs(Number(recent.sum) || 0) : 0;
  const runRemain = MAX_PER_RUN - recentUsed;
  if (runRemain <= 0) return 0;
  // 同方向继续扣额度；反方向允许（回来不受限，否则会永远卡死）
  if (Math.sign(used) !== 0 && Math.sign(used) !== Math.sign(delta) && Math.abs(used) >= MAX_PER_DAY) return delta;
  const mag = Math.min(Math.abs(delta), remain, runRemain);
  return Math.sign(delta) * mag;
}

function spendBudget(budget, axis, delta) {
  const used = Number(budget.day?.[axis] || 0);
  budget.day[axis] = used + delta;
  // 短期窗口记账（2 小时内同一根轴累加）——存在 day.__recent 里，随 dayBudget 落盘
  if (!budget.day.__recent || typeof budget.day.__recent !== 'object') budget.day.__recent = {};
  const ledger = budget.day.__recent;
  const prev = ledger[axis];
  const fresh = !prev || !prev.at || (Date.now() - Number(prev.at) > 2 * 60 * 60 * 1000);
  const sum = fresh ? delta : Number(prev.sum || 0) + delta;
  ledger[axis] = { at: Date.now(), sum };
  if (!budget.recent) budget.recent = {};
  budget.recent[axis] = ledger[axis];
}

/**
 * 把「罪名的写法」归一化成「正面名字 + 正负号」（2026-11-02）。
 * 为什么：推理层常把结果写成 {"怯懦":2}，而 applyDeltas 只认 axis 正面名
 * （{"勇敢":-2}），所以那些增量以前都被静默丢掉了。
 */
export function normalizeDeltas(deltas = {}) {
  const out = {};
  for (const [name, raw] of Object.entries(deltas || {})) {
    const n = Number(raw) || 0;
    if (!n) continue;
    const hit = axisOf(name);
    if (!hit) continue;
    const delta = dragSign(n) * hit.sign;
    // 同一个轴出现两次就合并
    out[hit.axis] = clampAxis((out[hit.axis] || 0) + delta);
  }
  return out;
}

// 只取符号，幅度交给调用方限制
function dragSign(n) {
  return n > 0 ? 1 : n < 0 ? -1 : 0;
}

export function applyDeltas(deltas = {}, { reason = '', file = VIRTUE_FILE, now = Date.now() } = {}) {
  const source = normalizeDeltas(deltas);
  let state = readVirtue(file);
  state = decayVirtue(state, now).state;
  const axes = { ...state.axes };
  const budget = dayBudget(state, now);
  const changed = [];
  for (const [axis, raw] of Object.entries(source)) {
    if (!AXES.some(([v]) => v === axis)) continue;
    const want = Math.sign(Number(raw) || 0) * MAX_PER_EVENT_REASON;
    const delta = clampByBudget(want, budget, axis);
    if (!delta) continue;
    const before = axes[axis];
    const after = clampAxis(before + delta);
    if (after === before) continue;
    axes[axis] = after;
    spendBudget(budget, axis, delta);
    changed.push({ name: axis, side: after > 0 ? '德' : '罪', from: before, to: after });
  }
  if (changed.length) {
    state = writeVirtue({ ...state, axes, dayBudget: budget.day, dayBudgetDate: budget.date, lastReason: String(reason || '').slice(0, 80) }, file) || state;
  }
  return { changed, state };
}

export function applyText(text, { isOwner = false, file = VIRTUE_FILE, now = Date.now() } = {}) {
  const s = String(text || '');
  if (!s.trim()) return { changed: [], state: readVirtue(file) };

  let state = readVirtue(file);
  state = decayVirtue(state, now).state;

  // 每条轴只要「最强的一次推动」，同时记住是哪句话推动的（2026-11-04 主人要求）
  const push = {};
  for (const rule of RULES) {
    const hit = s.match(rule.re);
    if (!hit) continue;
    const why = '命中「' + String(hit[0]).slice(0, 18) + '」';
    for (const [name, mag] of Object.entries(rule.up || {})) {
      const a = axisOf(name);
      if (!a) continue;
      const delta = a.sign * Math.min(MAX_PER_EVENT, Math.abs(Number(mag) || 0));
      const prev = push[a.axis];
      if (!prev || Math.abs(delta) > Math.abs(prev.delta)) push[a.axis] = { delta, why };
    }
  }

  const axes = { ...state.axes };
  const budget = dayBudget(state, now);
  const changed = [];
  for (const [axis, p] of Object.entries(push)) {
    const delta = clampByBudget(p.delta, budget, axis);
    if (!delta) continue;
    const before = axes[axis];
    const after = clampAxis(before + delta);
    if (after !== before) {
      axes[axis] = after;
      spendBudget(budget, axis, delta);
      changed.push({ name: axis, side: after > 0 ? '德' : '罪', from: before, to: after, why: p.why || '' });
    }
  }
  if (changed.length) {
    state = writeVirtue({ ...state, axes, dayBudget: budget.day, dayBudgetDate: budget.date }, file) || state;
  }
  return { changed, state };
}

/* ── 读给人看 ───────────────────────────────────────────────── */

/** 「谦卑 +6」/「傲慢 −7」这种一句话摘要 */
export function axisSummary(axes) {
  return AXES.map(([v, sin]) => {
    const n = clampAxis(axes?.[v]);
    if (n === 0) return null;
    return n > 0 ? `${v} +${n}` : `${sin} −${Math.abs(n)}`;
  }).filter(Boolean).join('、');
}

/** 绝对值最大的几项（兼容旧接口） */
export function dominantItems(axes) {
  return AXES
    .map(([v, sin]) => {
      const n = clampAxis(axes?.[v]);
      return { name: n >= 0 ? v : sin, axis: v, value: n, score: Math.abs(n) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
}

/**
 * 每根轴**管哪个场合**（2026-11-02 主人指出的问题）。
 *
 * 主人说：「矛盾了就不太好了，不同的德行管的行为应该也不同」——
 * 对。十根轴如果写成"同时生效的清单"，就会出现
 * 「又傲慢又怯懦」「又想炸又懒得动」这种自相矛盾的画像。
 * 实际上它们分域：每根轴只在自己那个场合当家，别的场合它不说话。
 */
export const SCENES = {
  谦卑: '被人夸、被人比较、评价自己的时候',
  傲慢: '被人夸、被人比较、评价自己的时候',
  仁爱: '别人难受、别人需要帮忙的时候',
  嫉妒: '别人比我好、别人被你偏疼的时候',
  耐心: '别人慢、事情拖、要等的时候',
  暴怒: '被冒犯、被耍、被敷衍的时候',
  勤勉: '有活要干、要花力气的时候',
  懒惰: '有活要干、要花力气的时候',
  慷慨: '分东西、有人开口要的时候',
  贪婪: '分东西、有人开口要的时候',
  节制: '吃、玩、爽，想再来一次的时候',
  暴食: '吃、玩、爽，想再来一次的时候',
  贞洁: '有人来撩、看到好看的人、夜深的时候',
  色欲: '有人来撩、看到好看的人、夜深的时候',
  诚实: '说错了、被追问、想糊弄过去的时候',
  虚伪: '说错了、被追问、想糊弄过去的时候',
  勇敢: '有风险、有冲突、要开口的时候',
  怯懦: '有风险、有冲突、要开口的时候',
  好奇: '碰到没见过的东西、看到新鲜事的时候',
  无趣: '碰到没见过的东西、看到新鲜事的时候',
};

/**
 * 给提示词用的德行块。只写「明显偏了」的轴（|值| ≥ 4）。
 * 平静居中的轴一律不写——没有倾向就是没有倾向，不用占字数。
 */
export function virtuePromptBlock({ file = VIRTUE_FILE, now = Date.now() } = {}) {
  const state = readVirtue(file);
  // 2026-11-02 主人反馈"德行拉满了她还是老样子"，查出两个原因：
  //   ① INJECT_MAX=4 → 十根轴只有四根被写进提示词，其余六根等于不存在
  //   ② 结尾那句写着"倾向决定你怎么做事"，等于告诉她**说话不用管性格**
  // 现在：极值（3 根以上到 ±8）就把十根全给，并明确"性格也管说话态度"。
  const all = dominantItems(state.axes).filter((x) => x.score >= INJECT_THRESHOLD);
  const extreme = all.filter((x) => Math.abs(Number(x.value)) >= 8).length;
  const limit = extreme >= 3 ? Math.max(all.length, INJECT_MAX) : INJECT_MAX;
  const items = all.slice(0, limit);
  if (!items.length) return '';

  const lines = ['【你此刻的性格倾向】（这是你这个人现在的样子，和「心情」是两回事）'];
  for (const it of items) {
    const name = it.value > 0 ? it.axis : (AXES.find(([v]) => v === it.axis)?.[1] ?? it.axis);
    const desc = DESCRIPTIONS[name] || '';
    const scene = SCENES[name] || '';
    const side = it.value > 0 ? '美德这一端' : '宗罪这一端';
    const strong = Math.abs(Number(it.value)) >= 8 ? '【偏到极致】' : '';
    lines.push(`- 偏${name}（${it.value > 0 ? '+' : '−'}${Math.abs(it.value)}/10，${side}）${strong}`
      + `${scene ? `｜${scene}当家` : ''}：${desc}`);
  }
  lines.push('（每根轴都是一条绳的两头：越往这头走，另一头就越远。'
    + '**每根轴只管自己那个场合**——碰到什么场面，才由那根轴当家，别的轴在那种场合不吭声。'
    + '所以这不是一张"同时发作"的清单，不用把它们凑成一个统一的人格，也不许因此变成四不像。'
    + '**心情决定情绪的浓度，性格决定你用什么态度说话、做什么事**——两样都要带出来。'
    + '偏到极致的那几根，是你的本性，说话时就该露出那个味儿，不用刻意收着。'
    + '不要主动报数值，也别拿它当借口。）');
  return `${lines.join('\n')}\n\n`;
}

export { VIRTUE_FILE, MAX_PER_EVENT, INJECT_THRESHOLD, INJECT_MAX };
