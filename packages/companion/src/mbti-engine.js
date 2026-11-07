/**
 * SurfCore · 八维推导引擎 v3（2026-11-03 主人定：不存数值，实时推）
 *
 * 核心变化：**八维不再是一份独立状态**。
 *   老版本：value/progress/devs/回弹/日上限 —— 一整套漂移机器，还得防它乱飘。
 *   新版本：八维 = f(德行十轴 + 行为账本 + 心情)，**每次现算，纯函数，不存**。
 *
 * 为什么这样更对：
 *   ① 只有一份真相（德行和行为是源头），不会再出现"MBTI 说冷、德行说软"
 *   ② 她真的会因为被长期怎么对待而变（德行挪了，型就跟着挪），不用额外的漂移规则
 *   ③ 拆掉了所有阻尼机器：不存值 → 不用管日上限、回弹、累加器
 *
 * 三层时间尺度（照真人的来）：
 *   此刻   = 德行当前值 + 最近 24 小时的行为 + 当下心情   → 分钟级抖动
 *   这周   = 德行当前值 + 最近 7 天的行为                → 拿来读型码
 *   型码   = 每 7 天重算一次；新型距离比旧型小 60 分以上才翻
 *   自称   = 存下来不重算（行为读出 ISFP、她嘴上还说 INFP —— 真人就这样）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FUNCTION_KEYS, matchType, presetRadar, priorityLines, radarLine, beebeStack,
} from './mbti-functions.js';
import { readVirtue } from './virtue-engine.js';
// 心情自己读（bridge 里的那几个 helper 不在 mood-shared，别跨模块引）

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.join(path.dirname(HERE), 'data');
const MBTI_FILE = path.join(STATE, 'mbti.json');
const BEHAVIOR_FILE = path.join(STATE, 'mbti-behavior.jsonl');
const WEIGHTS_FILE = path.join(STATE, 'mbti-weights.json');

const BASE = 40;                 // 每根功能的底分
const WINDOW_NOW = 24 * 3600e3;  // "此刻"看 24 小时
const WINDOW_WEEK = 7 * 86400e3; // "这周"看 7 天
const CODE_FLIP_MARGIN = 60;     // 新型要比旧型近 60 分才翻
const CODE_REFRESH_MS = 7 * 86400e3;
const BEHAVIOR_KEEP_MS = 14 * 86400e3;
const COUNT_CAP = 5;             // 单个行为最多算 5 次，防刷

/** 默认权重表（会写进 state/mbti-weights.json，你可以直接改数字，不用动代码） */
const DEFAULT_WEIGHTS = {
  Fe: { virtue: { 仁爱: 2, 谦卑: 1.5 }, behavior: { 主动开口: 2, 哄人: 2 } },
  Fi: { virtue: { 诚实: 3, 贞洁: 1 }, behavior: { 不改口: 2 } },
  Te: { virtue: { 勤勉: 3 }, behavior: { 目的办成: 3 } },
  Ti: { virtue: { 诚实: 2 }, behavior: { 抓住矛盾: 3, 被追问理由: 1 } },
  Si: { virtue: { 节制: 2 }, behavior: { 翻旧账: 3 } },
  Se: { virtue: { 暴食: 2, 色欲: 1 }, behavior: { 核对事实: 2 } },
  Ne: { virtue: { 好奇: 3 }, behavior: { 打了比方: 2 } },
  Ni: { virtue: { 好奇: 1.5 }, behavior: { 猜对动机: 4 } },
};

const clamp = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));

/* ── 权重表 ─────────────────────────────────────────────────── */

export function readWeights() {
  try {
    const raw = JSON.parse(fs.readFileSync(WEIGHTS_FILE, 'utf8').replace(/^\uFEFF/, ''));
    if (raw && typeof raw === 'object' && Object.keys(raw).length) return raw;
  } catch {}
  try {
    fs.mkdirSync(STATE, { recursive: true });
    fs.writeFileSync(WEIGHTS_FILE, JSON.stringify(DEFAULT_WEIGHTS, null, 2), 'utf8');
  } catch {}
  return DEFAULT_WEIGHTS;
}

/* ── 行为账本 ───────────────────────────────────────────────── */

export function noteBehavior(kind, now = Date.now()) {
  const k = String(kind || '').trim();
  if (!k) return;
  try {
    fs.mkdirSync(STATE, { recursive: true });
    fs.appendFileSync(BEHAVIOR_FILE, JSON.stringify({ at: now, kind: k }) + '\n', 'utf8');
  } catch {}
}

/** 读行为账本 → { counts24h, counts7d, total } */
export function readBehavior(now = Date.now()) {
  const out = { counts24h: {}, counts7d: {}, total: 0 };
  let lines = [];
  try {
    lines = fs.readFileSync(BEHAVIOR_FILE, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  } catch { return out; }
  const kept = [];
  for (const line of lines) {
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    const at = Number(rec?.at) || 0;
    if (!at || now - at > BEHAVIOR_KEEP_MS) continue;
    kept.push(line);
    const kind = String(rec.kind || '');
    if (!kind) continue;
    out.counts7d[kind] = (out.counts7d[kind] || 0) + 1;
    if (now - at <= WINDOW_NOW) out.counts24h[kind] = (out.counts24h[kind] || 0) + 1;
    out.total += 1;
  }
  // 顺手清掉过期行，别让文件无限长
  if (kept.length !== lines.length) {
    try { fs.writeFileSync(BEHAVIOR_FILE, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8'); } catch {}
  }
  return out;
}

/* ── 推导：德行 + 行为 + 心情 → 八维 ─────────────────────────── */

/**
 * @param {object} p
 * @param {object} p.virtue   德行十轴（−10~+10）
 * @param {object} p.counts   行为计数（窗口内的次数）
 * @param {object} p.mood     {tier, specials} 只影响"此刻"
 * @param {boolean} p.withMood 此刻层才叠心情
 * @returns {{radar:object, evidence:object}}
 */
export function deriveRadar({ virtue = {}, counts = {}, mood = null, withMood = false, weights = null } = {}) {
  const W = weights || readWeights();
  const radar = {};
  const evidence = {};
  for (const f of FUNCTION_KEYS) {
    const rule = W[f] || {};
    let v = BASE;
    const why = [];
    for (const [axis, w] of Object.entries(rule.virtue || {})) {
      const val = Number(virtue?.[axis]) || 0;
      if (!val) continue;
      const add = val * Number(w);
      v += add;
      why.push(`${axis}${val > 0 ? '+' : ''}${val}×${w}=${add > 0 ? '+' : ''}${Math.round(add)}`);
    }
    for (const [kind, w] of Object.entries(rule.behavior || {})) {
      const n = Math.min(COUNT_CAP, Number(counts?.[kind]) || 0);
      if (!n) continue;
      const add = n * Number(w);
      v += add;
      why.push(`${kind}×${n}=+${add}`);
    }
    // 心情只在"此刻"层叠一点：发火偏结论、开心偏发散
    if (withMood && mood) {
      const tier = Number(mood.tier) || 3;
      if (tier <= 2 && (f === 'Te' || f === 'Ti')) { v += 3; why.push('有气+3'); }
      if (tier <= 2 && f === 'Fe') { v -= 2; why.push('有气−2'); }
      if (tier >= 5 && f === 'Ne') { v += 3; why.push('开心+3'); }
      if (tier >= 5 && f === 'Fe') { v += 2; why.push('开心+2'); }
    }
    radar[f] = clamp(v);
    evidence[f] = why;
  }
  return { radar, evidence };
}

/* ── 状态（只存型码/自称/漂移记录，不存八维数值）─────────────── */

function freshState() {
  const code = 'INFP';
  return { version: 3, code, codeSince: 0, selfClaim: code, history: [], updatedAt: 0 };
}

function sanitize(raw) {
  const st = freshState();
  if (!raw || typeof raw !== 'object') return st;
  st.code = String(raw.code || st.code).toUpperCase();
  st.selfClaim = String(raw.selfClaim || st.code).toUpperCase();
  st.codeSince = Number(raw.codeSince) || 0;
  st.history = Array.isArray(raw.history) ? raw.history.slice(-30) : [];
  st.updatedAt = Number(raw.updatedAt) || 0;
  return st;
}

export function readMbti(file = MBTI_FILE) {
  try { return sanitize(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))); }
  catch { return freshState(); }
}

export function writeMbti(state, file = MBTI_FILE) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const out = { ...sanitize(state), updatedAt: Date.now() };
    fs.writeFileSync(file, JSON.stringify(out, null, 2), 'utf8');
    return out;
  } catch { return null; }
}

function ownerQq() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(path.dirname(STATE), 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
    return String(c.ownerQQ ?? '');
  } catch { return ''; }
}

function currentMood() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(STATE, 'mood.json'), 'utf8').replace(/^\uFEFF/, ''));
    const key = ownerQq() ? `person:${ownerQq()}` : 'default';
    const st = j.byKey?.[key] || j.byKey?.default || {};
    const list = (st.specials && st.specials.length) ? st.specials : (st.special ? [st.special] : []);
    return { tier: Number.isInteger(st.tier) ? st.tier : 3, specials: list.map((x) => String(x?.id || '')).filter(Boolean) };
  } catch { return { tier: 3, specials: [] }; }
}

function currentVirtue() {
  try { return readVirtue()?.axes || {}; } catch { return {}; }
}

/**
 * 周级型码：每 7 天算一次，新型要比旧型近 60 分才翻。
 * 翻的时候留一条记录（哪周、从什么到什么、因为什么）。
 */
export function refreshCode({ file = MBTI_FILE, now = Date.now(), radarWeek = null } = {}) {
  const st = readMbti(file);
  const need = !st.codeSince || now - st.codeSince >= CODE_REFRESH_MS;
  if (!need) return st;
  let radar = radarWeek;
  if (!radar) {
    const beh = readBehavior(now);
    radar = deriveRadar({ virtue: currentVirtue(), counts: beh.counts7d }).radar;
  }
  const match = matchType(radar);
  // 2026-11-04：判定改成四字母直接算之后，老的"比模板距离"就没意义了。
  // 现在翻牌看「最弱那一维够不够硬」：四个字母里最接近翻盘的那一维，
  // 差距也要 >= 8 分才算定型，否则这周沿用旧码（跟原来 60 分门槛是一个意思）。
  const flipped = match.code !== st.code && Number(match.minMargin) >= 8;
  const next = { ...st, codeSince: now };
  if (flipped) {
    next.code = match.code;
    next.history = [...(st.history || []), {
      at: now, from: st.code, to: match.code, dist: match.dist, oldDist: Math.round(oldDist),
    }].slice(-30);
  }
  return writeMbti(next, file) || next;
}

/** 读数：此刻 + 这周 + 型码 + 证据 */
export function readout(file = MBTI_FILE) {
  const st = refreshCode({ file });
  const virtue = currentVirtue();
  const beh = readBehavior();
  const mood = currentMood();
  const nowR = deriveRadar({ virtue, counts: beh.counts24h, mood, withMood: true });
  const weekR = deriveRadar({ virtue, counts: beh.counts7d });
  const nowMatch = matchType(nowR.radar);
  const weekMatch = matchType(weekR.radar);
  return {
    code: st.code,
    selfClaim: st.selfClaim,
    codeSince: st.codeSince,
    codeAgeDays: st.codeSince ? Math.floor((Date.now() - st.codeSince) / 86400e3) : 0,
    radarNow: nowR.radar,
    radarWeek: weekR.radar,
    evidenceNow: nowR.evidence,
    evidenceWeek: weekR.evidence,
    nowCode: nowMatch.code,
    weekCode: weekMatch.code,
    shaky: weekMatch.shaky,
    second: weekMatch.second,
    behavior: { counts24h: beh.counts24h, counts7d: beh.counts7d, total: beh.total },
    history: st.history,
    priority: priorityLines(weekR.radar, 3),
    stack: beebeStack(st.code),
    line: radarLine(weekR.radar, 4),
  };
}

/* ── 兼容接口（bridge 还在用的那五个 + 两个写入）─────────────── */

const norm = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function weekRadar() {
  return deriveRadar({ virtue: currentVirtue(), counts: readBehavior().counts7d }).radar;
}

export function wantTalk() {
  const r = weekRadar();
  const dom = [...FUNCTION_KEYS].sort((a, b) => r[b] - r[a])[0];
  const domOut = dom === 'Se' || dom === 'Ne' || dom === 'Te' || dom === 'Fe';
  const v = 0.5 + (domOut ? 0.2 : -0.1) + (r.Fe - 50) / 250 + (r.Se - 50) / 400 + (r.Ne - 50) / 400;
  return Number(norm(v, 0.05, 1).toFixed(2));
}
export function sentenceShape() {
  const r = weekRadar();
  if (r.Fe >= 60) return 'feel-first';
  if (r.Te + r.Ti >= 120) return 'conclude-first';
  return 'neutral';
}
export function patienceBias() {
  const r = weekRadar();
  return Number(norm(1 + (r.Te + r.Ti - r.Fe - r.Fi) / 400, 0.85, 1.15).toFixed(2));
}
export function metaphorAllowed() { return weekRadar().Ne >= 55; }
export function planBias() {
  const r = weekRadar();
  return Number(norm((r.Te + r.Si) / 200, 0, 1).toFixed(2));
}

/** 注意力集中度（目的数量/寿命用它） */
export function focusScore() {
  const r = weekRadar();
  const raw = (r.Ni + r.Si + r.Ti + r.Te) / 400;
  return Number(norm((raw - 0.25) / 0.30, 0, 1).toFixed(2));
}
export function maxActiveMotives() { return Math.round(6 - 4 * focusScore()); }
export function motiveTtlFactor() { return Number((0.4 + 1.6 * focusScore()).toFixed(2)); }

/** 老接口：记一次"行为事件"。名字保留，bridge/motive 不用改。 */
export function applyEvent(kind) { noteBehavior(kind); return { ok: true }; }

/** 老接口：心情已经由 deriveRadar 现算，这里只留空实现（bridge 还在调） */
export function applyMoodDev() { return null; }

/* ── 提示词 ─────────────────────────────────────────────────── */

export function mbtiPromptBlock() {
  try {
    const r = readout();
    const bits = [`这周读作 ${r.weekCode}`];
    if (r.nowCode !== r.weekCode) bits.push(`此刻偏 ${r.nowCode}`);
    if (r.weekCode !== r.code) bits.push(`自称还是 ${r.code}`);
    const head = `【此刻的她】${r.code}（${bits.join('｜')}）｜${r.line}`;
    const grab = r.priority.map((s) => `· ${s}`).join('\n');
    return `${head}\n先抓这些：\n${grab}\n\n`;
  } catch { return ''; }
}
