#!/usr/bin/env node
/**
 * 大肥鱼状态总控面板 v2（2026-11-03）
 *
 * 只读本机小服务：读 state/ 里的文件，吐一个自动刷新的页面。
 * 人格改成**八边形雷达图**（荣格八维 0~100），可以一键导出 1080 PNG（录视频用）。
 *
 *   node scripts/panel.mjs         → http://127.0.0.1:3999
 *   node scripts/panel.mjs 4000    → 换端口
 *
 * 只监听回环地址，不对外；不写任何状态。
 */

import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readout, focusScore, maxActiveMotives, motiveTtlFactor } from '../src/mbti-engine.js';
import { tarotReroll } from '../src/tarot-engine.js';
import { FUNCTION_KEYS } from '../src/mbti-functions.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const STATE = path.join(ROOT, 'data');
const ASSETS = path.join(HERE, 'panel-assets');   // 16 只人格鱼
// 大肥鱼的本子（小鱼的日记与惦记的事）
const NOTEBOOK = process.env.SURFCORE_NOTEBOOK
  || path.join(STATE, 'notebook');
const PORT = Number(process.argv[2]) || 3999;
const OWNER = (() => {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
    return String(c.ownerIds?.[0] || c.ownerQQ || '') || '';
  } catch { return ''; }
})();

const PANEL_LOG = path.join(STATE, 'panel.log');
const readJson = (name) => {
  try { return JSON.parse(fs.readFileSync(path.join(STATE, name), 'utf8').replace(/^\uFEFF/, '')); }
  catch { return null; }
};
const MIN = 60000;

function bridgeAlive() {
  return { alive: true, pid: process.pid };
}

function moodSnapshot() {
  const j = readJson('mood.json');
  let byKey = j?.byKey;
  if (!byKey || typeof byKey !== 'object') {
    const sess = readJson('session_moods.json') || {};
    const moodKeyToTier = {
      furious: 0, angry: 1, pout: 2, irritable: 1,
      flat: 3, sleepy: 3, tired: 3, bored: 3,
      good: 4, content: 4,
      happy: 5, excited: 6
    };
    byKey = {
      default: {
        tier: 3,
        cause: '今日基准心境：平静',
        sinceAt: Date.now(),
        updatedAt: Date.now(),
        specials: []
      }
    };
    if (j && typeof j === 'object') {
      const daily = Object.values(j).find((v) => v && v.key && v.label);
      if (daily) {
        byKey.default.tier = moodKeyToTier[daily.key] ?? 3;
        byKey.default.cause = `今日心境基线：${daily.label}`;
        byKey.default.sinceAt = daily.at || Date.now();
      }
    }
    const ownerUid = String(OWNER || '578021239').replace(/[^\d]/g, '');
    for (const [sKey, sVal] of Object.entries(sess)) {
      if (!sVal) continue;
      const t = moodKeyToTier[sVal.key] ?? 3;
      const isOwner = sKey.includes(ownerUid);
      const k = isOwner ? `person:${ownerUid}` : sKey;
      byKey[k] = {
        tier: t,
        cause: sVal.reason || sVal.label || sVal.key || '',
        sinceAt: sVal.updatedAt || Date.now(),
        updatedAt: sVal.updatedAt || Date.now(),
        specials: t !== 3 ? [{ id: sVal.key === 'pout' ? '委屈' : '开心', cause: sVal.reason || '', strength: sVal.intensity || 1, leftMin: 60, ageMin: 0, sinceAt: sVal.updatedAt || Date.now() }] : []
      };
    }
  }
  const now = Date.now();
  const pick = (key) => {
    const m = byKey[key];
    if (!m) return null;
    const specials = (Array.isArray(m.specials) && m.specials.length ? m.specials : (m.special ? [m.special] : []))
      .map((s) => ({
        id: String(s.id || ''),
        cause: String(s.cause || ''),
        strength: Number(s.strength) || 1,
        leftMin: s.until ? Math.max(0, Math.round((Number(s.until) - now) / MIN)) : null,
        ageMin: s.sinceAt ? Math.round((now - Number(s.sinceAt)) / MIN) : null,
        // 2026-11-04 主人要求：链条型要能看出「走到哪了」，潮汐型要驱动水面
        sinceAt: Number(s.sinceAt) || 0,
        firstAt: Number(s.firstAt) || Number(s.sinceAt) || 0,
        until: Number(s.until) || 0,
        hits: Number(s.hits) || 0,
      }));
    return {
      tier: Number.isInteger(Number(m.tier)) ? Number(m.tier) : 3,
      cause: String(m.cause || ''),
      ageMin: m.sinceAt ? Math.round((now - Number(m.sinceAt)) / MIN) : null,
      frozenMin: Number(m.frozenUntil) > now ? Math.round((Number(m.frozenUntil) - now) / MIN) : 0,
      specials,
      lastActivityMin: m.lastActivityAt ? Math.round((now - Number(m.lastActivityAt)) / MIN) : null,
    };
  };
  const owner = pick(`person:${OWNER}`) || pick('default');
  const others = Object.keys(byKey)
    .filter((k) => k !== `person:${OWNER}` && k !== 'default')
    .map((k) => ({ key: k, ...pick(k) }))
    .filter((x) => x.tier !== 3 || x.specials.length)
    .slice(0, 6);
  return { owner, others };
}

function virtueSnapshot() {
  const j = readJson('virtue.json');
  if (!j?.axes) return null;
  const now = Date.now();
  const decayAt = Number(j.decayAt) || 0;
  return {
    axes: j.axes,
    lastReason: String(j.lastReason || ''),
    day: j.dayBudget || {},
    nextDecayMin: decayAt ? Math.max(0, Math.round((decayAt + 3 * 24 * 60 * MIN - now) / MIN)) : null,
  };
}

function mbtiSnapshot() {
  try {
    const r = readout();
    return {
      code: r.code,
      selfClaim: r.selfClaim,
      weekCode: r.weekCode,
      nowCode: r.nowCode,
      shaky: r.shaky,
      second: r.second,
      radarNow: r.radarNow,
      radarWeek: r.radarWeek,
      evidence: r.evidenceWeek,
      priority: r.priority,
      stack: r.stack,
      codeAgeDays: r.codeAgeDays,
      behavior: r.behavior,
      history: (r.history || []).slice(-4).reverse(),
    };
  } catch { return null; }
}

/** 注意力元信息：集中度、上限、寿命倍数（决定她同时惦记几件事） */
function motiveMeta() {
  try {
    const focus = focusScore();
    return {
      focus,
      cap: maxActiveMotives(),
      ttlFactor: motiveTtlFactor(),
      label: focus >= 0.75 ? '很集中' : focus >= 0.5 ? '偏集中' : focus >= 0.3 ? '偏散' : '很散',
    };
  } catch { return null; }
}

function motiveSnapshot() {
  const j = readJson('motive.json');
  const goals = Array.isArray(j?.goals) ? j.goals : [];
  const now = Date.now();
  return goals
    .filter((g) => g && g.goal && !g.attainedAt && !g.droppedAt)
    .map((g) => ({
      goal: String(g.goal || ''),
      how: String(g.how || ''),
      done: String(g.done || ''),
      target: String(g.targetName || g.targetKey || ''),
      leftMin: g.ttlMs && g.createdAt ? Math.max(0, Math.round((Number(g.createdAt) + Number(g.ttlMs) - now) / MIN)) : null,
    }))
    .slice(0, 6);
}

function focusSnapshot() {
  const j = readJson('focus.json');
  if (!j) return null;
  const now = Date.now();
  return {
    platform: String(j.platform || ''),
    current: j.current || '',
    sinceMin: j.sinceAt ? Math.round((now - Number(j.sinceAt)) / MIN) : null,
    errand: j.errand ? {
      what: String(j.errand.what || j.errand.goal || ''),
      ageMin: j.errand.touchAt ? Math.round((now - Number(j.errand.touchAt)) / MIN) : null,
    } : null,
  };
}

function intentSnapshot() {
  const j = readJson('intents.json');
  const list = Array.isArray(j) ? j : (Array.isArray(j?.intents) ? j.intents : []);
  return list.filter((x) => x && !x.doneAt && !x.canceledAt).slice(-5).map((x) => ({
    text: String(x.say || x.text || x.why || x.kind || ''),
    target: String(x.targetKey || x.target || ''),
  }));
}

function notebookList() {
  const out = [];
  const walk = (dir, rel) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { walk(full, r); continue; }
      if (!/\.md$/i.test(e.name)) continue;
      try {
        const st = fs.statSync(full);
        const head = fs.readFileSync(full, 'utf8').slice(0, 140).replace(/\s+/g, ' ').trim();
        out.push({ path: r, dir: rel || '', title: e.name.replace(/\.md$/i, ''), size: st.size, mtime: st.mtimeMs, head });
      } catch {}
    }
  };
  walk(NOTEBOOK, '');
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/** 读一篇本子；只认本子目录里的 .md，挡住 .. 和绝对路径 */
function noteRead(rel) {
  try {
    const s = String(rel || '');
    if (!s || s.includes('..') || s.startsWith('/') || s.includes('\\')) return { error: 'bad path' };
    const root = path.resolve(NOTEBOOK);
    const full = path.resolve(root, s);
    if (full !== root && !full.startsWith(root + path.sep)) return { error: 'outside' };
    if (!/\.md$/i.test(full)) return { error: 'not md' };
    const st = fs.statSync(full);
    if (st.size > 600 * 1024) return { error: 'too big', size: st.size };
    return { path: s, size: st.size, mtime: st.mtimeMs, text: fs.readFileSync(full, 'utf8') };
  } catch (e) { return { error: String(e?.message || e) }; }
}

/**
 * 实时推理：bridge.log 里推理层的痕迹
 *   [德行] (推理) 耐心 -1→0，仁爱 -2→-1｜对方在哄她、主动补偿
 *   [心情] 这句在哄她，挡掉 1 个负面情绪
 *   [目的·说话] 她自己推出来了：……
 */
function reasoningSnapshot() {
  try {
    const file = path.join(STATE, 'bridge.log');
    if (!fs.existsSync(file)) {
      return { last: null, pushes: [], event: null, goal: null, llmCount: 0, ruleCount: 0 };
    }
    const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).slice(-800);
    const pushes = [];
    let event = null, goal = null, ruleCount = 0, llmCount = 0;
    for (const line of lines) {
      const m = line.match(/^(\d{2}:\d{2}:\d{2}) \[bridge\] (.*)$/);
      if (!m) continue;
      const [, at, body] = m;
      if (/\[德行\]/.test(body)) {
        const mm = body.match(/\[德行\](?:\s*\(([^)]+)\))?\s*([^｜]+)(?:｜(.+))?/);
        if (mm) {
          const source = (mm[1] || '规则表').trim();
          // 推理层 / 规则表 / 她自己说出口的话，都算「谁推动的」；bili 那种自动行为不算
          if (!/^(推理|规则表|规则|她说)$/.test(source)) continue;
          if (source === '推理') llmCount++; else ruleCount++;
          pushes.push({ at, source, changes: mm[2].trim(), reason: (mm[3] || '').trim() });
        }
      }
      if (/\[心情\]/.test(body) && /推理|判断|哄|敷衍|阴阳|挡掉/.test(body)) {
        event = { at, text: body.replace(/^\[心情\]\s*/, '') };
      }
      if (/\[目的(·说话)?\]/.test(body)) {
        goal = { at, text: body.replace(/^\[目的(·说话)?\]\s*/, '') };
      }
    }
    return {
      last: pushes.length ? pushes[pushes.length - 1] : null,
      pushes: pushes.slice(-4).reverse(),
      event, goal,
      llmCount, ruleCount,
    };
  } catch { return null; }
}

function logTail(n = 12) {
  try {
    return fs.readFileSync(path.join(STATE, 'bridge.log'), 'utf8').trim().split(/\r?\n/).slice(-n);
  } catch { return []; }
}

/** 各状态文件的"数据多旧"（毫秒），面板上直接标出来 */
function fileAges() {
  const out = {};
  for (const f of ['mood.json', 'virtue.json', 'mbti.json', 'mbti-behavior.jsonl', 'motive.json', 'focus.json', 'bridge.log']) {
    try { out[f] = Math.max(0, Date.now() - fs.statSync(path.join(STATE, f)).mtimeMs); }
    catch { out[f] = null; }
  }
  return out;
}

const AXIS_ALL = ['谦卑', '仁爱', '耐心', '勤勉', '慷慨', '节制', '贞洁', '诚实', '勇敢', '好奇'];
const TIER_NAMES = ['非常愤怒', '生气', '有点生气', '平静', '有点小开心', '开心', '十分开心'];
const EDIT_LOG = path.join(STATE, 'panel-edits.log');
function editLog(line) {
  try { fs.appendFileSync(EDIT_LOG, new Date().toISOString() + ' ' + line + '\n'); } catch {}
}

// 动手之前先备份，改坏了能捞回来
function backupState(name) {
  try {
    const src = path.join(STATE, name);
    if (!fs.existsSync(src)) return null;
    const dir = path.join(STATE, 'backup');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dst = path.join(dir, name + '.' + stamp);
    fs.copyFileSync(src, dst);
    return dst;
  } catch { return null; }
}

// 2026-11-04：每次重置都记下「重置前的备份」，好让「刚刚手滑了」能一键退回去
const UNDO_FILE = path.join(STATE, 'undo.json');
function readUndo() {
  try { return JSON.parse(fs.readFileSync(UNDO_FILE, 'utf8').replace(/^\uFEFF/, '')) || {}; } catch { return {}; }
}
function recordUndo(target, items) {
  const all = readUndo();
  all[target] = { at: Date.now(), items: items.filter((x) => x && x.backup) };
  try { fs.writeFileSync(UNDO_FILE, JSON.stringify(all, null, 1), 'utf8'); } catch {}
}
function doUndo(target) {
  const all = readUndo();
  const rec = all[target];
  if (!rec || !rec.items || !rec.items.length) return { ok: false, error: '没有可撤销的重置（重置过才有的撤）' };
  const done = [];
  for (const it of rec.items) {
    try {
      if (!it.backup || !fs.existsSync(it.backup)) continue;
      fs.copyFileSync(it.backup, path.join(STATE, it.file));
      done.push(it.file);
    } catch (e) { /* 单个失败不影响别的 */ }
  }
  delete all[target];
  try { fs.writeFileSync(UNDO_FILE, JSON.stringify(all, null, 1), 'utf8'); } catch {}
  editLog('撤销重置 ' + target + ' → ' + done.join(','));
  if (!done.length) return { ok: false, error: '备份文件不见了，没撤成' };
  return { ok: true, restored: done };
}

function doReset(target) {
  const now = Date.now();
  if (target === 'virtue') {
    const file = path.join(STATE, 'virtue.json');
    if (!fs.existsSync(file)) return { ok: false, error: '没有 virtue.json' };
    const backup = backupState('virtue.json');
    const day = new Date(now).toISOString().slice(0, 10);
    const axes = {};
    for (const a of AXIS_ALL) axes[a] = 0;
    const out = { version: 2, axes, updatedAt: now, lastReason: '面板手动重置', decayAt: now, dayBudgetDate: day, dayBudget: {} };
    fs.writeFileSync(file, JSON.stringify(out, null, 2), 'utf8');
    recordUndo('virtue', [{ file: 'virtue.json', backup }]);
    return { ok: true, backup, at: now };
  }
  if (target === 'mood') {
    const file = path.join(STATE, 'mood.json');
    if (!fs.existsSync(file)) return { ok: false, error: '没有 mood.json' };
    const backup = backupState('mood.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    for (const key of Object.keys(raw.byKey || {})) {
      const e = raw.byKey[key] || {};
      raw.byKey[key] = {
        ...e, tier: 3, frozenUntil: 0, cause: '面板手动重置',
        specials: [], special: null, sinceAt: now, updatedAt: now,
      };
    }
    raw.updatedAt = now;
    fs.writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8');
    recordUndo('mood', [{ file: 'mood.json', backup }]);
    return { ok: true, backup, at: now };
  }
  if (target === 'mbti') {
    const mbtiFile = path.join(STATE, 'mbti.json');
    const behFile = path.join(STATE, 'mbti-behavior.jsonl');
    if (!fs.existsSync(mbtiFile) && !fs.existsSync(behFile)) return { ok: false, error: '没有 mbti 文件' };
    const b1 = backupState('mbti.json');
    const b2 = backupState('mbti-behavior.jsonl');
    // 清自我声明型 + 型码 + 历史，行为账本清空；weight/统计外壳本身是推导出来的，不存文件
    const fresh = { version: 3, code: null, codeSince: 0, selfClaim: null, history: [], updatedAt: now, lastReason: '面板手动重置 MBTI' };
    fs.writeFileSync(mbtiFile, JSON.stringify(fresh, null, 2), 'utf8');
    if (fs.existsSync(behFile)) fs.writeFileSync(behFile, '', 'utf8');
    recordUndo('mbti', [{ file: 'mbti.json', backup: b1 }, { file: 'mbti-behavior.jsonl', backup: b2 }]);
    return { ok: true, backup: b1 || b2, at: now };
  }
  return { ok: false, error: '未指定要重置哪个（target=virtue|mood）' };
}

// 2026-11-04：点一下改单个数值（德行某根轴 / 情绪温度档位）
function doSet(kind, params) {
  const now = Date.now();
  if (kind === 'virtue') {
    const axis = String(params.get('axis') || '');
    const val = Math.round(Number(params.get('value')));
    if (!AXIS_ALL.includes(axis)) return { ok: false, error: '没有这根轴：' + axis };
    if (!Number.isFinite(val) || val < -10 || val > 10) return { ok: false, error: '数值要在 −10 ~ +10' };
    const file = path.join(STATE, 'virtue.json');
    const j = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const from = Number(j.axes?.[axis] || 0);
    j.axes = j.axes || {};
    j.axes[axis] = val;
    j.updatedAt = now;
    j.lastReason = '面板手动改 ' + axis + ' ' + from + '→' + val;
    // 手动改不吃每日额度：把这根轴的当日预算清掉，免得跟「每天 2 格」打架
    if (j.dayBudget && typeof j.dayBudget === 'object') {
      delete j.dayBudget[axis];
      if (j.dayBudget.__recent) delete j.dayBudget.__recent[axis];
    }
    fs.writeFileSync(file, JSON.stringify(j, null, 2), 'utf8');
    editLog('德行 ' + axis + ' ' + from + '→' + val);
    return { ok: true, from, to: val };
  }
  if (kind === 'mood') {
    const val = Math.round(Number(params.get('value')));
    if (!Number.isFinite(val) || val < 0 || val > 6) return { ok: false, error: '档位要在 0 ~ 6' };
    const want = String(params.get('key') || '');
    const file = path.join(STATE, 'mood.json');
    const j = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    j.byKey = j.byKey || {};
    const has = (k) => Object.prototype.hasOwnProperty.call(j.byKey, k);
    const ownerKey = 'person:' + String(OWNER || '');
    const target = (want && has(want)) ? want : (has(ownerKey) ? ownerKey : 'default');
    if (!j.byKey[target]) {
      j.byKey[target] = { tier: 3, cause: '', sinceAt: now, specials: [] };
    }
    const keys = [target];
    let changed = 0;
    for (const k of keys) {
      const e = j.byKey[k];
      if (!e) continue;
      const from = Number(e.tier);
      e.tier = val;
      e.sinceAt = now;
      e.updatedAt = now;
      // 手动改的档位给 20 分钟保护期，不然下一轮情绪结算就把它冲了
      e.frozenUntil = now + 20 * 60 * 1000;
      e.cause = '面板手动改成「' + TIER_NAMES[val] + '」（20 分钟内不被对话改掉）';
      editLog('情绪 ' + k + ' 档位 ' + from + '→' + val);
      changed += 1;
    }
    j.updatedAt = now;
    fs.writeFileSync(file, JSON.stringify(j, null, 2), 'utf8');

    // 同步到小鱼的 session_moods.json，让私聊实时生效
    try {
      const sessFile = path.join(STATE, 'session_moods.json');
      let sess = {};
      try { sess = JSON.parse(fs.readFileSync(sessFile, 'utf8')); } catch {}
      const tierToKey = { 0: 'irritable', 1: 'pout', 2: 'pout', 3: 'flat', 4: 'good', 5: 'happy', 6: 'happy' };
      const ownerUid = String(OWNER || '578021239');
      const sessKey = 'private:' + ownerUid;
      sess[sessKey] = {
        key: tierToKey[val] || 'flat',
        reason: '面板手动调节为「' + TIER_NAMES[val] + '」',
        intensity: val >= 5 || val <= 1 ? 2 : 1,
        updatedAt: now,
        turnsSinceUpdate: 0
      };
      fs.writeFileSync(sessFile, JSON.stringify(sess, null, 2), 'utf8');
    } catch {}

    return { ok: true, changed, to: val };
  }
  return { ok: false, error: 'kind 只能是 virtue / mood' };
}

function setTarotEnabled(enabled) {
  const file = path.join(STATE, 'tarot.json');
  let st = {};
  try { st = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { st = { date: '', history: [] }; }
  st.enabled = Boolean(enabled);
  st.updatedAt = Date.now();
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(st, null, 1), 'utf8');
  return { ok: true, enabled: st.enabled };
}

// 2026-11-04：清空实时聊天记录（先备份，再清空文件）
function doClearChat() {
  const file = path.join(STATE, 'chat-tail.jsonl');
  if (!fs.existsSync(file)) return { ok: true, cleared: 0, backup: null };
  let n = 0;
  try { n = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length; } catch {}
  const backup = backupState('chat-tail.jsonl');
  try { fs.writeFileSync(file, '', 'utf8'); } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  editLog('清除聊天记录 ' + n + ' 条');
  return { ok: true, cleared: n, backup };
}

// 自主学习：读经验库，算「学到多少 / 什么时候学的 / 最近几天节奏」
// 实时聊天：读桥接写下的 chat-tail.jsonl（收发各一行），没有时从 turns.jsonl 回填
function chatSnapshot() {
  let rows = [];
  const file = path.join(STATE, 'chat-tail.jsonl');
  try {
    if (fs.existsSync(file)) {
      rows = fs.readFileSync(file, 'utf8')
        .split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    }
  } catch { rows = []; }

  // 如果没有独立的 chat-tail.jsonl，从共享对话流水 turns.jsonl 中提取老爸私聊记录
  if (!rows.length) {
    try {
      const turnsFile = path.join(STATE, 'turns.jsonl');
      if (fs.existsSync(turnsFile)) {
        const raw = fs.readFileSync(turnsFile, 'utf8')
          .split('\n').filter(Boolean)
          .map((l) => { try { return JSON.parse(l); } catch { return null; } })
          .filter(Boolean);
        for (const t of raw) {
          if (!t || !t.where || (!t.where.startsWith('private') && !t.where.includes('578021239'))) continue;
          const time = Number(t.t) || Date.now();
          if (t.text) {
            let clean = t.text.replace(/^[^\s：:]+[（(][^）)]+[）)][：:]\s*/, '').replace(/^[^\s：:]+[：:]\s*/, '').trim();
            rows.push({ dir: 'in', text: clean || t.text, at: time });
          }
          if (t.reply) {
            rows.push({ dir: 'out', text: t.reply, at: time + 600 });
          }
        }
      }
    } catch {}
  }

  const tail = rows.slice(-40);
  return {
    rows: tail,
    total: rows.length,
    lastAt: tail.length ? Number(tail[tail.length - 1].at) || 0 : 0,
    lastDir: tail.length ? String(tail[tail.length - 1].dir || '') : '',
  };
}

function relationshipSnapshot() {
  const people = readJson('people.json') || {};
  const respect = readJson('respect.json') || { users: {} };
  const ownerUin = '578021239';

  const nodes = [];
  const links = [];

  // 1. 中心节点：小肥鱼
  nodes.push({
    id: 'self',
    name: '小肥鱼',
    role: 'AI 伴侣',
    tier: 'self',
    interactions: 9999,
    isSelf: true,
  });

  // 2. 老爸（养父）
  const ownerPerson = people[ownerUin] || {};
  nodes.push({
    id: ownerUin,
    name: ownerPerson.name || '老爸 (真是咩咩又罗罗)',
    role: '老爸 · 养父',
    tier: 'family',
    interactions: Math.max(ownerPerson.interactions || 0, 2281),
    topics: (ownerPerson.topics || []).slice(-3),
    affinity: 100,
    isOwner: true,
  });
  links.push({
    source: 'self',
    target: ownerUin,
    type: 'family',
    label: '最亲密的养父 (唯一特权)',
    value: 10,
  });

  // 3. 处理 respect.json（讨厌/警告）
  const dislikedMap = {};
  for (const [uid, u] of Object.entries(respect.users || {})) {
    if (uid === ownerUin) continue;
    dislikedMap[uid] = u;
  }

  // 4. 从 people.json 中挑选互动频繁的群友
  const entries = Object.entries(people)
    .filter(([uid]) => uid !== ownerUin && uid !== '123456')
    .map(([uid, p]) => {
      const resp = dislikedMap[uid];
      return {
        id: uid,
        name: p.name || uid,
        interactions: Number(p.interactions) || 0,
        topics: (p.topics || []).slice(-3),
        facts: (p.facts || []).slice(-3),
        lastSeenAt: p.lastSeenAt || 0,
        respect: resp || null,
      };
    })
    .sort((a, b) => b.interactions - a.interactions);

  // 取常聊群友前 16 名，加上所有黑名单人员（确保拉黑的人全景在图上可见）
  const includedIds = new Set();
  const topFriends = entries.slice(0, 16);
  for (const f of topFriends) includedIds.add(f.id);

  for (const [uid, u] of Object.entries(dislikedMap)) {
    if (!includedIds.has(uid) && u.disliked) {
      const p = people[uid] || {};
      topFriends.push({
        id: uid,
        name: u.name || p.name || uid,
        interactions: p.interactions || 0,
        topics: (p.topics || []).slice(-2),
        facts: (p.facts || []).slice(-2),
        lastSeenAt: p.lastSeenAt || 0,
        respect: u,
      });
      includedIds.add(uid);
    }
  }

  for (const item of topFriends) {
    const isDisliked = item.respect?.disliked || item.respect?.strikes >= 3;
    const isWarning = !isDisliked && item.respect && item.respect.strikes > 0;
    const tier = isDisliked ? 'disliked' : (isWarning ? 'warning' : 'friend');
    
    nodes.push({
      id: item.id,
      name: item.name,
      role: isDisliked ? `讨厌 · 已拉黑(${item.respect.reason === 'harass' ? '骚扰' : '辱骂'})` : (isWarning ? `警告中(${item.respect.strikes}次越界)` : '常聊群友'),
      tier,
      interactions: item.interactions,
      topics: item.topics,
      strikes: item.respect?.strikes || 0,
      reason: item.respect?.reason || '',
      disliked: Boolean(isDisliked),
    });

    links.push({
      source: 'self',
      target: item.id,
      type: tier,
      label: isDisliked ? '已拉黑/冷落' : (isWarning ? '警戒中' : `互动 ${item.interactions} 次`),
      value: isDisliked ? 2 : Math.min(8, Math.max(3, Math.round(Math.log10(item.interactions + 1) * 3))),
    });
  }

  return {
    nodes,
    links,
    summary: {
      totalTracked: Object.keys(people).length,
      dislikedCount: Object.values(respect.users || {}).filter(u => u.disliked).length,
      warningCount: Object.values(respect.users || {}).filter(u => !u.disliked && u.strikes > 0).length,
    }
  };
}

function lessonSnapshot() {
  const j = readJson('lessons.json');
  const list = (j && j.lessons) || [];
  const now = Date.now();
  const dayKeyOf = (ms) => {
    const d = new Date(ms);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };
  const rows = list.map((x) => ({
    text: String(x.text || ''),
    kind: String(x.kind || ''),
    hits: Number(x.hits) || 0,
    at: Number(x.createdAt) || 0,
  })).filter((x) => x.text).sort((a, b) => a.at - b.at);
  const byDay = {};
  for (const r of rows) byDay[dayKeyOf(r.at)] = (byDay[dayKeyOf(r.at)] || 0) + 1;
  const days = [];
  for (let i = 6; i >= 0; i -= 1) {
    const k = dayKeyOf(now - i * 86400e3);
    days.push({ label: k.slice(5), n: byDay[k] || 0 });
  }
  const todayKey = dayKeyOf(now);
  const last = rows.length ? rows[rows.length - 1].at : 0;
  return {
    total: rows.length,
    today: byDay[todayKey] || 0,
    last,
    lastMin: last ? Math.round((now - last) / 60000) : null,
    days,
    recent: rows.slice(-7).reverse(),
  };
}

function snapshot() {
  return {
    now: Date.now(),
    owner: OWNER,
    bridge: bridgeAlive(),
    mood: moodSnapshot(),
    virtue: virtueSnapshot(),
    mbti: mbtiSnapshot(),
    motives: motiveSnapshot(),
    motiveMeta: motiveMeta(),
    focus: focusSnapshot(),
    intents: intentSnapshot(),
    fnKeys: FUNCTION_KEYS,
    files: fileAges(),
    reasoning: reasoningSnapshot(),
    tarot: readJson('tarot.json'),
    lessons: lessonSnapshot(),
    chat: chatSnapshot(),
    relationships: relationshipSnapshot(),
    notebook: notebookList(),
    logs: logTail(12),
  };
}

const PAGE = String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>大肥鱼 · 总控面板</title>
<style>
  :root{--bg:#0d1117;--card:#161b22;--line:#232b36;--txt:#e6edf3;--dim:#8b949e;--accent:#39d0a8;--warn:#f0a35e;--bad:#f0616d;--cool:#6aa9ff}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.55 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
  header{display:flex;align-items:center;gap:12px;padding:12px 18px;border-bottom:1px solid var(--line);position:sticky;top:0;background:#0d1117ee;backdrop-filter:blur(8px);z-index:9;flex-wrap:wrap}
  h1{font-size:15px;margin:0;font-weight:600}
  .pill{font-size:12px;padding:2px 9px;border-radius:99px;border:1px solid var(--line);color:var(--dim)}
  .pill.ok{color:var(--accent);border-color:#1f6f5c}
  .pill.bad{color:var(--bad);border-color:#7a2d34}
  main{display:grid;grid-template-columns:420px 1fr;gap:14px;padding:14px 18px 40px;align-items:start}
  @media(max-width:900px){main{grid-template-columns:1fr}}
  .col{display:flex;flex-direction:column;gap:14px}
    .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:13px 15px;position:relative}
  /* 常驻呼吸：很轻，一直在慢慢亮灭 */
  .card::before{content:"";position:absolute;inset:-1px;border-radius:inherit;pointer-events:none;
    border:1px solid rgba(57,208,168,.06);
    box-shadow:0 0 9px rgba(57,208,168,.028);
    animation:cardBreath 7s ease-in-out infinite;animation-delay:var(--bd,0s)}
  @keyframes cardBreath{
    0%,100%{border-color:rgba(57,208,168,.05);box-shadow:0 0 7px rgba(57,208,168,.02)}
    50%{border-color:rgba(57,208,168,.20);box-shadow:0 0 16px rgba(57,208,168,.09)}
  }
  /* 变化时：慢慢亮起来，再慢慢灭 */
  .card::after{content:"";position:absolute;inset:-1px;border-radius:inherit;pointer-events:none;
    border:1px solid rgba(140,255,220,.9);opacity:0;
    box-shadow:0 0 26px rgba(57,208,168,.45), 0 0 64px rgba(57,208,168,.16)}
  .card.pulse::after{animation:cardFlash 2.4s ease-in-out 1}
  @keyframes cardFlash{
    0%{opacity:0;transform:scale(1)}
    16%{opacity:1}
    55%{opacity:.55}
    100%{opacity:0}
  }
  .card h2{font-size:12.5px;margin:0 0 9px;color:var(--dim);font-weight:600;letter-spacing:.05em;display:flex;align-items:center;gap:8px}
  .big{font-size:22px;font-weight:600}
  .sub{color:var(--dim);font-size:12.5px;margin-top:4px}
  .vrow{margin:9px 0}
  .vhead{display:flex;align-items:baseline;justify-content:space-between;font-size:11.5px;line-height:1.2}
  .vsin{color:#f0616d88}
  .vvir{color:#39d0a888}
  .vnum{font-variant-numeric:tabular-nums;font-weight:600;font-size:13px}
  .vbar{position:relative;height:9px;background:#0b0f14;border:1px solid var(--line);border-radius:99px;overflow:hidden;margin-top:4px}
  .vbar::after{content:'';position:absolute;left:50%;top:-1px;bottom:-1px;width:1px;background:#2b3542}
  .vfill{position:absolute;top:0;bottom:0;border-radius:2px}
  .dots{display:flex;gap:5px;margin:8px 0 2px}
  .dot{flex:1;min-width:0;height:7px;border-radius:99px;background:#0b0f14;border:1px solid var(--line)}
  .dot.on{background:var(--accent);border-color:var(--accent)}
  .dot.on.hot{background:var(--bad);border-color:var(--bad)}
  .chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
  .chip{font-size:12px;padding:2px 8px;border-radius:99px;background:#1d2530;border:1px solid var(--line)}
  .chip em{color:var(--dim);font-style:normal;margin-left:4px}
  ul{list-style:none;margin:0;padding:0}
  li{padding:6px 0;border-bottom:1px dashed #1c232c}
  li:last-child{border-bottom:0}
  li .t{font-size:13px}
  li .m{color:var(--dim);font-size:12px;margin-top:2px}
  pre{margin:0;font-size:12px;line-height:1.6;color:#a9b4c0;white-space:pre-wrap;word-break:break-all;max-height:210px;overflow:auto}
  .radar-wrap{display:flex;justify-content:center;align-items:center;margin:2px 0 2px}
  .mbti-under{display:flex;gap:0;align-items:center;justify-content:space-between;margin-top:8px;padding-right:8px}
  .mbti-under .fish-side{margin-right:14px}
  .mbti-under .nums{grid-template-columns:1fr;gap:3px 0}
  .mbti-title{display:flex;align-items:baseline;gap:10px;margin:2px 0 6px}
  #mbtiBig{font-size:29px;font-weight:800;letter-spacing:.03em;line-height:1.15}
  .mbti-group{font-size:11.5px;color:var(--dim);letter-spacing:.06em}
  .fish-side{display:flex;flex-direction:column;align-items:center}
  .fish-name{font-size:19px;font-weight:800;letter-spacing:.08em;line-height:1.1;margin:0 0 -2px;
             text-align:center;white-space:nowrap;text-shadow:0 2px 10px rgba(0,0,0,.45)}
  #fishAvatar{width:auto;height:auto;max-width:156px;max-height:198px;object-fit:contain;display:block;border-radius:0;box-shadow:none;filter:drop-shadow(0 10px 18px rgba(0,0,0,.55))}
  svg{flex:none}
  .nums{display:grid;grid-template-columns:1fr 1fr;gap:2px 16px;font-size:12.5px;color:var(--dim)}
  .mbti-under .nums{grid-template-columns:1fr;gap:3px 0;min-width:178px}
  .nums b{color:var(--txt);font-weight:600;font-variant-numeric:tabular-nums}
  .btn{font-size:12px;padding:3px 10px;border-radius:8px;border:1px solid var(--line);background:#1d2530;color:var(--txt);cursor:pointer}
  .btn:hover{border-color:var(--accent);color:var(--accent)}
  .prio li{font-size:12.5px;color:#c9d4e0}
  /* 德行 / 目的 两栏压紧一档 */
  .compact{padding:11px 14px}
  .compact h2{margin:0 0 6px}
  .compact .vrow{margin:5px 0}
  .compact .vhead{font-size:10.5px}
  .compact .vnum{font-size:12px}
  .compact .vbar{height:7px;margin-top:3px}
  .vhit{padding:5px 0 3px;cursor:pointer}
  .vhit:hover .vbar{background:#121a23}
  .compact li{padding:4px 0}
  .compact li .t{font-size:12.5px}
  .compact li .m{font-size:11.5px;margin-top:1px;line-height:1.45}
  .empty{color:var(--dim);font-size:12.5px}
/* 目的横切两栏 + 情绪放大贴右边 */
  .split{display:grid;grid-template-columns:1fr .62fr;gap:14px;align-items:start}
  @media(max-width:980px){.split{grid-template-columns:1fr}}
  #motives ul{columns:2;column-gap:20px}
  #motives li{break-inside:avoid;-webkit-column-break-inside:avoid}
  .splitA{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) 336px;gap:14px;align-items:start}
  @media(max-width:1380px){.splitA{grid-template-columns:1fr 1fr}.chatcard{grid-column:1/-1}}
  .vfoot{margin-top:auto;padding-top:10px;border-top:1px dashed #1f2833}
  #virtue{flex:1;display:flex;flex-direction:column}
  .dex-meta{display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--dim);
    margin-top:12px;padding-top:10px;border-top:1px dashed #1f2833}
  .pip{width:22px;height:9px;border-radius:3px;background:#222a35;border:1px solid var(--line)}
  .pip.on{background:var(--accent);border-color:var(--accent)}
  .dex-h{font-size:10.5px;color:var(--dim);letter-spacing:.05em;margin:12px 0 5px}
  .dex-row{display:flex;gap:7px;font-size:11.5px;color:#c9d4e0;margin:4px 0;line-height:1.45}
  .dex-row .t{width:38px;flex:none;color:#5a636f;font-variant-numeric:tabular-nums}
  .dex-row .why{color:var(--dim);font-size:11px}
  .dex-dot{display:inline-block;width:5px;height:5px;border-radius:99px;margin:0 5px 0 2px;vertical-align:middle}
  .dex-face{font-size:15.5px;color:var(--txt);font-weight:600;margin-top:6px;line-height:1.45}
  .dex-face em{color:var(--accent);font-style:normal}
  .dex-top{font-size:11px;color:var(--dim);margin-top:5px}
  .dex-decay{margin-top:10px;font-size:11.5px;color:var(--dim);line-height:1.7}
  .dex-decay b{color:var(--warn);font-weight:600}
  .splitB{display:grid;grid-template-columns:1.72fr 1fr;gap:14px;align-items:stretch}
  @media(max-width:1150px){.splitA,.splitB{grid-template-columns:1fr}.chatcard{grid-column:auto}}
  .splitA>.card,.splitB>.card{display:flex;flex-direction:column}
  .colR{display:flex;flex-direction:column;gap:14px}
  .colL{display:flex;flex-direction:column;gap:14px}
  /* 2026-11-04：德行卡收紧一点，给下面腾地方 */
  .colL .vhit{padding:3px 0 1px}
  .colL .vhead{margin-bottom:0}
  .colL .vbar{height:6px;margin-top:2px}
  .colL #virtue .vrow{margin-top:2px}
  .colL #virtue .dex-meta{margin-top:8px}
  .colL #virtue .dex-h{margin-top:8px}
  .learncard .lstat{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--dim);margin-bottom:8px}
  .learncard .pulse{width:8px;height:8px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 0 rgba(57,208,168,.6);animation:lpulse 2s infinite}
  .learncard .pulse.idle{background:#6b7684;animation:none;box-shadow:none}
  @keyframes lpulse{0%{box-shadow:0 0 0 0 rgba(57,208,168,.55)}70%{box-shadow:0 0 0 9px rgba(57,208,168,0)}100%{box-shadow:0 0 0 0 rgba(57,208,168,0)}}
  .learncard .bars{display:flex;align-items:flex-end;gap:5px;height:44px;margin:2px 0 10px}
  .learncard .bars i{flex:1;background:#1f6f5a;border-radius:3px 3px 0 0;min-height:2px;position:relative}
  .learncard .bars span{flex:1;font-size:9.5px;color:#4d5661;text-align:center}
  .learncard .ls{display:flex;gap:8px;padding:5px 0;border-top:1px solid #1b222b;font-size:12.5px;line-height:1.45}
  .learncard .ls .t{color:#5b6674;font-size:11px;flex:0 0 42px;padding-top:2px}
  .learncard .ls .x{flex:1;min-width:0}
  /* 实时聊天（悬浮手机窗） */
  .chatcard{background:var(--card);border:1px solid var(--line);align-self:start;display:flex;flex-direction:column;min-height:0;height:680px}
  .chatcard .cbody{padding:2px 0 4px;flex:1;display:flex;min-height:0}
  .chatcard.collapsed .cbody{display:none}
  .phonewrap{display:flex;justify-content:center;padding:4px 0 6px;flex:1;min-height:0}
  .phone{width:100%;max-width:360px;height:100%;display:flex;flex-direction:column;min-height:0;border-radius:26px;border:8px solid #070a0e;background:#0a0e13;
         box-shadow:0 14px 34px rgba(0,0,0,.55), 0 0 0 1px #1c242f;overflow:hidden}
  .phone .pbar{display:flex;align-items:center;gap:8px;padding:8px 12px;background:#11161d;
               border-bottom:1px solid #1c242f;font-size:11.5px;color:#9aa6b2}
  .phone .pbar b{color:#e6edf3;font-size:12.5px;font-weight:600}
  .phone .pbar .dotlive{width:7px;height:7px;border-radius:50%;background:var(--accent);margin-left:auto}
  .phone .screen{flex:1;min-height:380px;overflow:auto;padding:10px 10px 14px;background:radial-gradient(120% 60% at 50% 100%, #0d1f1b 0%, #0a0e13 62%), #0a0e13}
  .phone .screen::-webkit-scrollbar{width:6px}
  .phone .pinput{display:flex;gap:6px;padding:8px 10px;background:#11161d;border-top:1px solid #1c242f}
  .phone .pinput input{flex:1;background:#0a0e13;border:1px solid #1c242f;color:#e6edf3;padding:6px 10px;border-radius:12px;font-size:12px;outline:none}
  .phone .pinput input:focus{border-color:var(--accent)}
  .phone .pinput button{background:var(--accent);color:#070a0e;border:none;padding:0 12px;border-radius:12px;font-weight:600;font-size:11.5px;cursor:pointer}
  .phone .pinput button:hover{filter:brightness(1.1)}
  /* 人际关系图谱 */
  .relcard{grid-column:1 / -1;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:13px 15px}
  .rel-legend{position:absolute;bottom:10px;left:12px;display:flex;gap:12px;font-size:11px;color:var(--dim);background:rgba(13,17,23,.85);padding:4px 10px;border-radius:6px;pointer-events:none}
  .rel-legend span{display:flex;align-items:center;gap:5px}
  .rel-legend i{width:8px;height:8px;border-radius:50%;display:inline-block}
  .rel-btn{background:transparent;border:1px solid var(--line);color:var(--dim);padding:3px 10px;border-radius:6px;font-size:11.5px;cursor:pointer;transition:.15s}
  .rel-btn.active,.rel-btn:hover{background:#212833;color:var(--txt);border-color:var(--accent)}
  .rel-detail b{color:var(--txt);font-size:13.5px}
  .rel-detail .badge{display:inline-block;padding:2px 7px;border-radius:4px;font-size:11px;margin-bottom:4px}
  .badge.family{background:rgba(227,179,65,.15);color:#e3b341;border:1px solid rgba(227,179,65,.3)}
  .badge.friend{background:rgba(57,208,168,.15);color:#39d0a8;border:1px solid rgba(57,208,168,.3)}
  .badge.warning{background:rgba(240,163,94,.15);color:#f0a35e;border:1px solid rgba(240,163,94,.3)}
  .badge.disliked{background:rgba(240,97,109,.15);color:#f0616d;border:1px solid rgba(240,97,109,.3)}
  .rel-detail .topics{max-height:160px;overflow-y:auto;color:#a9b4c0;font-size:11px;display:flex;flex-direction:column;gap:5px}
  .rel-detail .topics div{background:#1a222d;padding:6px 8px;border-radius:5px;line-height:1.4}
  .rel-unblock-btn{background:#f0616d;color:#fff;border:none;padding:6px 12px;border-radius:6px;cursor:pointer;font-weight:600;margin-top:8px}
  .rel-unblock-btn:hover{filter:brightness(1.15)}
  .msg{display:flex;margin:7px 0;align-items:flex-end}
  .msg .b{max-width:74%;padding:7px 11px;border-radius:14px;font-size:12.5px;line-height:1.5;
          white-space:pre-wrap;word-break:break-word}
  .msg.fish .b{background:#12312a;border:1px solid #22594a;color:#d6f7ec;border-bottom-left-radius:5px}
  .msg.me{justify-content:flex-end}
  .msg.me .b{background:#1b2430;border:1px solid #2a3746;color:#e6edf3;border-bottom-right-radius:5px}
  .msg .t{font-size:9.5px;color:#4d5661;margin:0 5px 2px}
  /* 清空时：一条条慢慢飘走然后化掉 */
  .screen.clearing .msg{animation:msgGone .95s cubic-bezier(.33,.02,.5,1) forwards;
    animation-delay:calc(var(--i,0) * 80ms);overflow:hidden;max-height:400px}
  @keyframes msgGone{
    0%{opacity:1;transform:translateX(0) scale(1);filter:blur(0);max-height:400px}
    55%{opacity:.45;transform:translateX(-14px) scale(.97);filter:blur(1.2px)}
    85%{opacity:.12;transform:translateX(-26px) scale(.93);filter:blur(3px);max-height:60px}
    100%{opacity:0;transform:translateX(-34px) scale(.9);filter:blur(4px);max-height:0;margin:0;padding:0}
  }
  .screen .empty.fadein,.screen.fadein{animation:scrIn .5s ease}
  @keyframes scrIn{0%{opacity:0}100%{opacity:1}}
  .colR>.card{display:flex;flex-direction:column}
  .rc-line{margin:7px 0}
  .rc-top{display:flex;align-items:center;gap:8px;font-size:12.5px}
  .rc-tag{font-size:10.5px;padding:1px 7px;border-radius:99px;border:1px solid var(--line);color:var(--dim)}
  .rc-tag.llm{color:var(--warn);border-color:#5d4630}
  .rc-tag.rule{color:var(--cool);border-color:#2b4670}
  .rc-at{margin-left:auto;font-size:11px;color:var(--dim);font-variant-numeric:tabular-nums}
  .rc-chg{font-size:12.5px;color:var(--txt);margin-top:3px;font-weight:600}
  .rc-why{font-size:11.5px;color:var(--dim);margin-top:2px;line-height:1.45}
  .rc-sep{border-top:1px dashed #1f2833;margin:10px 0 6px}
  .rc-k{font-size:11px;color:var(--dim);letter-spacing:.04em}
  .rc-v{font-size:12px;color:#c9d4e0;line-height:1.5;margin-top:2px;word-break:break-all}
  .rc-stat{margin-top:auto;padding-top:9px;font-size:11px;color:var(--dim)}
  /* 情绪叠加：时间轨道 + 叠色 + 判读 */
  .stack{margin-top:10px}
  .stack-h{display:flex;justify-content:space-between;font-size:10.5px;color:var(--dim);letter-spacing:.05em;margin-bottom:6px}
  .trk{display:flex;align-items:center;gap:8px;margin:5px 0}
  .trk-n{width:82px;flex:none;font-size:11.5px;color:#c9d4e0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .trk-bar{position:relative;flex:1;height:10px;background:#0b0f14;border:1px solid var(--line);border-radius:99px;overflow:hidden}
  .trk-bar i{position:absolute;left:0;top:0;bottom:0;border-radius:99px;transition:width .9s linear}
  .trk-t{width:54px;flex:none;text-align:right;font-size:10.5px;color:var(--dim);font-variant-numeric:tabular-nums}
  .trk.mute .trk-n{color:var(--dim)}
  .mixrow{display:flex;gap:12px;align-items:center;margin-top:12px;padding-top:10px;border-top:1px dashed #1f2833}
  .mix{position:relative;width:92px;height:74px;flex:none}
  .mix i{position:absolute;border-radius:50%;mix-blend-mode:screen}
  .judge{flex:1;font-size:12px;line-height:1.55;color:#c9d4e0}
  .judge b{color:var(--accent);font-weight:600}
  .tag.chain{color:var(--warn);border-color:#5d4630}
  .tag.tide{color:var(--accent);border-color:#1f6f5c}
  .tag.timed{color:var(--cool);border-color:#2b4670}
  .nb-count{margin-left:auto;font-size:11px;color:var(--dim);font-weight:500}
  .nb-group{font-size:10.5px;color:var(--dim);letter-spacing:.08em;margin:8px 0 4px}
  .nb-item{border-radius:9px;border:1px solid transparent}
  .nb-item:hover{border-color:var(--line);background:#12171e}
  .nb-row{display:flex;align-items:center;gap:8px;padding:5px 8px;cursor:pointer;font-size:12.5px}
  .nb-dot{width:5px;height:5px;border-radius:99px;background:var(--accent);opacity:.65;flex:none}
  .nb-t{color:#dbe3ec;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .nb-meta{margin-left:auto;font-size:10.5px;color:#5a636f;flex:none}
  .nb-arrow{color:#5a636f;font-size:10px;transition:transform .15s;flex:none}
  .nb-item.open .nb-arrow{transform:rotate(90deg)}
  .nb-body{display:none;padding:2px 10px 10px 21px;font-size:11.5px;line-height:1.65;color:#a9b4c0;
    max-height:280px;overflow:auto;border-left:1px solid #1f2833;margin-left:11px}
  .nb-item.open .nb-body{display:block}
  .nb-body b{font-weight:600}
  .nb-loading{color:var(--dim);font-size:11.5px}
  .motiveFoot{margin-top:auto;padding-top:10px;border-top:1px dashed #1f2833;font-size:11.5px;color:var(--dim);line-height:1.5}
  .moodbig{display:flex;flex-direction:column;min-height:430px}
  .moodbig .big{font-size:34px;line-height:1.25}
  .moodbig .dots{margin:16px 0 10px;gap:6px}
  .moodbig .dot{height:13px}
  .moodbig .sub{font-size:12.5px;margin-top:6px;line-height:1.6}
  .moodbig .chip{font-size:12.5px;padding:3px 10px}
  .spblock{margin-top:12px;padding-top:12px;border-top:1px dashed #1f2833}
  .sp-t{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:600}
  .tag{font-size:10.5px;padding:1px 7px;border-radius:99px;border:1px solid var(--line);color:var(--dim);font-weight:500}
  .tag.chain{color:var(--warn);border-color:#5d4630}
  .tag.tide{color:var(--accent);border-color:#1f6f5c}
  .tag.timed{color:var(--cool);border-color:#2b4670}
  .sp-left{margin-left:auto;font-size:12px;color:var(--dim);font-weight:500}
  .sp-c{font-size:12px;color:var(--dim);margin-top:3px}
  .chain-track{display:flex;align-items:center;gap:6px;margin:9px 0 7px}
  .chain-track .node{font-size:11.5px;padding:2px 9px;border-radius:99px;border:1px solid var(--line);color:var(--dim);white-space:nowrap}
  .chain-track .node.on{color:#0d1117;background:var(--warn);border-color:var(--warn);font-weight:700}
  .chain-track .node.done{color:var(--warn);border-color:#5d4630}
  .chain-track .link{flex:1;height:1px;background:#2b3542}
  .cbar,.tbar{position:relative;height:8px;background:#0b0f14;border:1px solid var(--line);border-radius:99px;overflow:hidden}
  .cbar i,.tbar i{position:absolute;left:0;top:0;bottom:0;border-radius:99px;transition:width .9s linear}
  .cbar i{background:linear-gradient(90deg,#7a5730,var(--warn))}
  .tbar i{background:linear-gradient(90deg,#26405f,var(--cool))}
  .chain-sub,.sp-sub2{font-size:11.5px;color:var(--dim);margin-top:5px}
  #water{width:100%;flex:0 0 auto;height:158px;min-height:0;display:block;margin-top:10px;border-radius:10px;background:#0a0e13}
  .water-cap{font-size:11px;color:#4d5661;margin-top:4px;text-align:right}
  .rst{margin-left:auto;font:inherit;font-size:11px;padding:2px 9px;border-radius:6px;cursor:pointer;background:#221820;color:#f0616d;border:1px solid #4a2630}
  .rst:hover{background:#2e1d26}
  .sw{position:relative;display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-size:12px;color:var(--dim);margin-left:auto}
  .sw input{position:absolute;opacity:0;width:0;height:0}
  .sw i{display:block;width:38px;height:20px;border-radius:10px;background:#2b3340;position:relative;transition:background .18s}
  .sw i:before{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#8b949e;transition:transform .18s,background .18s}
  .sw input:checked+i{background:rgba(57,208,168,.35)}
  .sw input:checked+i:before{transform:translateX(18px);background:var(--accent)}
  .tarotcard .tname{font-size:23px;font-weight:700;letter-spacing:1px}
  .trow{display:flex;gap:16px;align-items:flex-start}
  .tinfo{flex:1 1 auto;min-width:0}
  .tcard{flex:0 0 auto;width:132px;height:220px;object-fit:cover;display:block;border-radius:10px;
         border:1px solid #2b3542;background:#0d1117;
         filter:brightness(.93) contrast(1.02);box-shadow:0 0 0 3px #11161d, 0 0 0 4px #232b36, 0 8px 22px rgba(0,0,0,.55)}
  .tcard-wrap{flex:0 0 auto;padding:4px;border-radius:12px;background:linear-gradient(160deg,#1b232e,#0f141b)}
  .tcard.rev{transform:rotate(180deg)}
  .rst,.und,.btn{white-space:nowrap}
  .und{font:inherit;font-size:11px;padding:2px 9px;border-radius:6px;cursor:pointer;background:#121821;
       color:#7f8b98;border:1px solid #2b3542}
  .und:hover{color:var(--txt);border-color:#3a4553}
  .rsti{font:inherit;font-size:11px;width:19px;height:19px;line-height:1;border-radius:50%;border:1px solid #2b3542;
        background:#121821;color:var(--dim);cursor:pointer;padding:0}
  .rsti:hover{color:var(--txt);border-color:#3a4553}
  .tsub{font-size:11px;color:#5b6674;font-weight:400;letter-spacing:.3px}
  .tarotcard ul{margin:6px 0 8px 18px;padding:0;color:#c6d0da}
</style></head>
<body>
<header>
  <h1>大肥鱼 · 总控面板</h1>
  <span class="pill" id="br">桥接检查中…</span>
  <span class="pill" id="plat"></span>
  <span class="pill" id="fresh"></span>
  <span class="pill" id="upd" style="margin-left:auto"></span>
</header>
<main>
  <div class="col">
    <section class="card">
      <h2 style="display:flex;align-items:center;gap:6px;flex-wrap:nowrap">人格雷达<span style="font-size:11px;color:var(--dim)">八维 0~100</span><button class="rst" id="rstMbti" style="margin-left:auto">重置</button><button class="und" id="undoMbti" title="撤销上一次重置">刚刚手滑了</button><button class="btn" id="png" style="margin-left:6px">导出 PNG</button></h2>
      <div class="mbti-title">
        <span id="mbtiBig">MBTI — ----</span>
        <span class="mbti-group" id="mbtiGroup"></span>
      </div>
      <div class="radar-wrap"><div id="radar"></div></div>
      <div class="mbti-under">
        <div class="fish-side"><div class="fish-name" id="fishName"></div><img id="fishAvatar" alt=""></div>
        <div class="nums" id="nums"></div>
      </div>
      <div class="sub" id="mbtiSub" style="margin-top:10px"></div>
      <ul class="prio" id="prio" style="margin-top:6px"></ul>
    </section>
    <section class="card"><h2>注意力（focus）</h2><div id="focus"></div></section>
    <section class="card"><h2>待办的意图</h2><div id="intents"></div></section>
    <section class="card nb"><h2>大肥鱼的本子<span class="nb-count" id="nbCount"></span></h2><div id="notebook"></div></section>
  </div>
  <div class="col">
    <div class="splitA">
      <div class="colL">
      <section class="card compact"><h2 style="display:flex;align-items:center;gap:8px">德行（−10 … +10）<button class="rst" id="rstVirtue">重置</button><button class="und" id="undoVirtue" title="撤销上一次重置">刚刚手滑了</button></h2><div id="virtue"></div></section>
      <section class="card learncard"><h2 style="display:flex;align-items:center;gap:8px">自主学习<span class="tsub">经验库 · 实时复盘</span></h2><div id="learn"></div></section>
      </div>
            <div class="colR">
      <section class="card moodbig"><h2 style="display:flex;align-items:center;gap:8px">心情（情绪）<button class="rst" id="rstMood">重置</button><button class="und" id="undoMood" title="撤销上一次重置">刚刚手滑了</button></h2><div id="mood"></div><canvas id="water"></canvas><div class="water-cap" id="waterCap"></div></section>
      <section class="card tarotcard"><h2 style="display:flex;align-items:center;gap:8px">塔罗牌灵<span class="tsub">趣味小模块 · 每日早上 6 点刷新</span><button class="und" id="tarotReroll" title="立刻重新抽一张，完全随机，可能又抽到同一张同一个牌位">重新手动抽牌</button><button class="rsti" id="tarotHelp" title="看规则">?</button><label class="sw"><input type="checkbox" id="tarotSw"><i></i><span id="tarotSwTxt">开</span></label></h2><div id="tarot"></div><div id="tarotRules" style="display:none;margin-top:10px;padding:10px 12px;border:1px dashed #2b3542;border-radius:8px;background:#0f141b;color:#a9b4c0;font-size:12px;line-height:1.75"><b style="color:#e6edf3">牌灵是怎么来的</b><br>· 每天 <b>06:00</b> 换一张（凌晨 5 点还算昨天的牌）<br>· <b>纯随机</b>：22 张 × 正逆位，一共 44 个牌位，不放回、不看德行情绪 MBTI<br>· <b>每天刷新有限制</b>：近 3 天出现过的「同一张牌 + 同一个正逆位」不进候选<br>· 也就是说：牌可以重复，<b>牌位</b>不重复（星星逆位之后，还能抽到星星正位）<br>· <b>「重新手动抽牌」不设任何限制</b>：44 个牌位纯随机，同一张同一个牌位也可能再抽到<br>· 它只调<b>说话的语气</b>，不改德行数值、不改情绪档位<br>· 会轻微影响当天<b>情绪敏感度</b>（最多 ±40%，只改"多容易触发"）<br>· 卡面按正逆位摆：逆位就是翻过来的那张<br>· 关掉右上开关 → 不抽牌、不注入，完全不参与</div><div id="tarotRules" style="display:none;margin-top:10px;padding:10px 12px;border:1px dashed #2b3542;border-radius:8px;background:#0f141b;color:#a9b4c0;font-size:12px;line-height:1.75"><b style="color:#e6edf3">牌灵是怎么来的</b><br>· 每天 <b>06:00</b> 换一张（凌晨 5 点还算昨天的牌）<br>· <b>纯随机</b>：22 张等概率、正逆位五五开，<b>不看</b>德行 / 情绪 / MBTI<br>· 近 <b>3 天</b>抽过的不进候选，免得天天撞同一张<br>· 它只调<b>说话的语气</b>，不改德行数值、不改情绪档位<br>· 会轻微影响当天<b>情绪敏感度</b>（最多 ±40%，只改“多容易触发”）<br>· 卡面按正逆位摆：逆位就是翻过来的那张<br>· 关掉右上开关 → 不抽牌、不注入，完全不参与</div></section>
      </div>
      <section class="card chatcard" id="chatCard"><h2 style="display:flex;align-items:center;gap:8px">实时聊天<span class="tsub" id="chatHint">她左你右 · 真实收发</span><button class="und" id="chatClear" title="把所有聊天记录清掉（先备份）">清除记录</button><button class="und" id="chatToggle" style="margin-left:auto">收起</button></h2><div class="cbody" id="chat"></div></section>
    </div>
    <div class="splitB">
      <section class="card compact"><h2>目的 / 想干的事</h2><div id="motives"></div></section>
      <section class="card"><h2>实时推理（规则表 + 推理层）</h2><div id="reasoning"></div></section>
    </div>
    <section class="card relcard" id="relCard">
      <h2 style="display:flex;align-items:center;gap:8px">
        人际关系网络图谱
        <span class="tsub">社交圈 · 养父与常聊群友 · 实时状态</span>
        <div class="rel-filter" id="relFilter" style="margin-left:auto;display:flex;gap:4px">
          <button class="rel-btn active" data-filter="all">全部</button>
          <button class="rel-btn" data-filter="family">老爸</button>
          <button class="rel-btn" data-filter="friend">常聊好友</button>
          <button class="rel-btn" data-filter="warning">警戒中</button>
          <button class="rel-btn" data-filter="disliked">讨厌名单</button>
        </div>
      </h2>
      <div class="rel-body" style="display:flex;gap:12px;position:relative">
        <div style="flex:1;position:relative">
          <canvas id="relCanvas" style="width:100%;height:380px;background:#0d1117;border-radius:8px;border:1px solid #232b36;cursor:grab;display:block"></canvas>
          <div id="relLegend" class="rel-legend">
            <span><i style="background:#e3b341"></i> 老爸 (养父)</span>
            <span><i style="background:#39d0a8"></i> 常聊好友</span>
            <span><i style="background:#f0a35e"></i> 警戒中</span>
            <span><i style="background:#f0616d"></i> 讨厌 (已拉黑)</span>
          </div>
        </div>
        <div id="relDetail" class="rel-detail" style="width:280px;background:#131820;border:1px solid #232b36;border-radius:8px;padding:12px;display:none;flex-direction:column;gap:8px;font-size:12px;line-height:1.5">
        </div>
      </div>
    </section>
    <section class="card"><h2>桥接日志</h2><pre id="logs"></pre></section>
  </div>
</main>
<script>
const TIERS=['非常愤怒','生气','有点生气','平静','有点小开心','开心','十分开心'];
const AXES=[['谦卑','傲慢'],['仁爱','嫉妒'],['耐心','暴怒'],['勤勉','懒惰'],['慷慨','贪婪'],['节制','暴食'],['贞洁','色欲'],['诚实','虚伪'],['勇敢','怯懦'],['好奇','无趣']];
const FN=["Ni","Ne","Si","Se","Ti","Te","Fi","Fe"];
const el=(id)=>document.getElementById(id);
const esc=(s)=>String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const mins=(m)=>m==null?'':(m<60?m+' 分钟':(m<1440?Math.round(m/60)+' 小时':Math.round(m/1440)+' 天'));

// 2026-11-04 面板写入：德行/心情重置、牌灵开关（都先备份，都在本机）
// 2026-11-04：点一下改数值
async function editVirtueAt(axis, ev){
  if(!ev || !ev.currentTarget) return;
  const box = ev.currentTarget;
  const r = box.getBoundingClientRect();
  const p = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
  const v = Math.round(p * 20 - 10);        // 0 → −10，0.5 → 0，1 → +10
  const res = await panelPost('/api/set?kind=virtue&axis='+encodeURIComponent(axis)+'&value='+v);
  if(!res.ok) alert('没改成：'+res.error);
  tick();
}
async function editVirtue(axis, cur){
  const raw = prompt('「'+axis+'」现在是 '+cur+'。输入新值（−10 ~ +10，正=美德侧，负=罪侧）：', cur);
  if(raw===null) return;
  const v = Math.round(Number(raw));
  if(!Number.isFinite(v) || v < -10 || v > 10){ alert('要 −10 到 +10 之间的整数'); return; }
  const r = await panelPost('/api/set?kind=virtue&axis='+encodeURIComponent(axis)+'&value='+v);
  if(!r.ok) alert('没改成：'+r.error);
  tick();
}
async function editMood(cur){
  const raw = prompt('温度档位现在是 '+cur+'（0 非常愤怒 … 3 平静 … 6 十分开心）。输入 0~6：', cur);
  if(raw===null) return;
  const v = Math.round(Number(raw));
  if(!Number.isFinite(v) || v < 0 || v > 6){ alert('要 0 到 6'); return; }
  const r = await panelPost('/api/set?kind=mood&value='+v);
  if(!r.ok) alert('没改成：'+r.error);
  tick();
}
async function editMoodAt(v){
  const r = await panelPost('/api/set?kind=mood&value='+v);
  if(!r.ok) alert('没改成：'+r.error);
  tick();
}
async function panelPost(u){ try{ const r=await fetch(u,{method:'POST'}); return await r.json(); }catch(e){ return {ok:false,error:String(e)}; } }

function wireButtons(){
  try { wireChat(); } catch {}
  const cc=el('chatClear');
  if(cc) cc.onclick=async()=>{
    if(cc.disabled) return;
    cc.disabled=true;
    try { await clearChat(); } finally { cc.disabled=false; }
  };
  // 2026-11-04：重置一律不弹确认框（备份照旧在后台悄悄做），按了立刻生效
  const flashBtn=(b,txt)=>{ if(!b) return; const old=b.textContent; b.textContent=txt;
    setTimeout(()=>{ b.textContent=old; }, 1000); };
  async function quickReset(target, btn, okText){
    if(btn && btn.disabled) return;
    if(btn) btn.disabled=true;
    try{
      const r=await panelPost('/api/reset?target='+target);
      if(!r.ok){ alert('没成：'+r.error); return; }
      flashBtn(btn, okText);
      tick();
    } finally { if(btn) btn.disabled=false; }
  }
  const rv=el('rstVirtue'), rm=el('rstMood'), sw=el('tarotSw');
  if(rv) rv.onclick=()=>quickReset('virtue', rv, '已归零');
  if(rm) rm.onclick=()=>quickReset('mood', rm, '已清空');
  // 2026-11-04：撤销重置 + 手动重抽
  // 2026-11-04：撤销也按了立即生效，不弹窗
  [['undoVirtue','virtue'],['undoMood','mood'],['undoMbti','mbti']].forEach(([id,target])=>{
    const b=el(id);
    if(b) b.onclick=async()=>{
      if(b.disabled) return;
      b.disabled=true;
      try{
        const r=await panelPost('/api/undo?target='+target);
        if(!r.ok){ flashBtn(b,'没有可撤的'); return; }
        flashBtn(b,'已撤回');
        tick();
      } finally { b.disabled=false; }
    };
  });
  const rr=el('tarotReroll');
  if(rr) rr.onclick=async()=>{
    rr.disabled=true;
    const r=await panelPost('/api/tarot/reroll');
    rr.disabled=false;
    if(!r.ok) alert('没抽成：'+r.error); 
    tick();
  };
  const rm2=el('rstMbti');
  if(rm2) rm2.onclick=()=>quickReset('mbti', rm2, '已重置');
  const hp=el('tarotHelp'), rl=el('tarotRules');
  if(hp&&rl) hp.onclick=()=>{ rl.style.display = (rl.style.display==='none' ? 'block' : 'none'); };
  if(sw) sw.onchange=async()=>{
    const on=sw.checked;
    const r=await panelPost('/api/tarot?enabled='+(on?'1':'0'));
    if(!r.ok){ sw.checked=!on; alert('没成：'+r.error); return; }
    el('tarotSwTxt').textContent=on?'开':'关';
    tick();
  };
}
// 自主学习卡：学到多少、最近几天节奏、最近几条、实时状态灯
// ── 实时聊天（2026-11-04：鱼在左、主人在右）──
function chatTime(ms){ return new Date(ms).toLocaleTimeString('zh-CN',{hour12:false}).slice(0,5); }

let CHAT_LAST_AT = 0;
let CHAT_CLEARING = false;

function animateBubblesOut(){
  const scr=el('chatScreen');
  const rows=scr ? [...scr.querySelectorAll('.msg')] : [];
  if(!rows.length) return Promise.resolve();
  const anims=rows.map((r,i)=>r.animate([
    {opacity:1, transform:'translateX(0) scale(1)', filter:'blur(0px)', maxHeight:'400px', margin:'7px 0'},
    {opacity:.55, transform:'translateX(-14px) scale(.97)', filter:'blur(1.2px)', maxHeight:'90px', margin:'5px 0', offset:.55},
    {opacity:0, transform:'translateX(-30px) scale(.92)', filter:'blur(3.5px)', maxHeight:'0px', margin:'0px'},
  ], {duration:820, delay:i*70, easing:'cubic-bezier(.35,.02,.55,1)', fill:'forwards'}));
  return Promise.all(anims.map(a=>a.finished.catch(()=>null)));
}

async function clearChat(){
  CHAT_CLEARING = true;
  try { await animateBubblesOut(); } catch(e){}
  const r=await panelPost('/api/chat/clear');
  CHAT_CLEARING = false;
  if(!r.ok){ alert('没清成：'+r.error); tick(); return; }
  CHAT_LAST_AT = 0;
  renderChat({rows:[], total:0, lastAt:0, lastDir:''});
  const s2=el('chatScreen');
  if(s2){ s2.classList.remove('clearing'); s2.classList.add('fadein');
    setTimeout(()=>s2.classList.remove('fadein'), 700); }
}

function bindChatInput(){
  const inp=el('chatInput');
  const btn=el('chatSendBtn');
  if(!inp||inp.dataset.bound) return;
  inp.dataset.bound='1';
  const doSend=async()=>{
    const txt=(inp.value||'').trim();
    if(!txt) return;
    inp.value='';
    const scr=el('chatScreen');
    if(scr){
      scr.innerHTML+='<div class="msg me"><div class="b">'+esc(txt)+'</div><span class="t">'+chatTime(Date.now())+'</span></div>';
      scr.scrollTop=scr.scrollHeight;
    }
    try{
      const res=await panelPost('/api/chat/send?text='+encodeURIComponent(txt));
      if(res&&res.reply&&scr){
        scr.innerHTML+='<div class="msg fish"><div class="b">'+esc(res.reply)+'</div><span class="t">'+chatTime(Date.now())+'</span></div>';
        scr.scrollTop=scr.scrollHeight;
      }
    }catch(e){}
    setTimeout(tick, 1000);
  };
  inp.addEventListener('keydown', (e)=>{ if(e.key==='Enter') doSend(); });
  if(btn) btn.addEventListener('click', doSend);
}

function renderChat(c){
  if(CHAT_CLEARING) return;
  const box=el('chat'); if(!box) return;
  const head='<div class="phonewrap"><div class="phone"><div class="pbar"><b>大肥鱼</b><span>QQ私聊</span><i class="dotlive"></i></div>';
  const foot='<div class="pinput"><input id="chatInput" placeholder="给小鱼发消息（回车发送）..." autocomplete="off"><button id="chatSendBtn">发送</button></div></div></div>';
  if(!c||!c.rows.length){ box.innerHTML=head+'<div class="screen" id="chatScreen"><div class="empty" style="padding:14px">还没有聊天记录</div></div>'+foot; bindChatInput(); return; }
  const rows=c.rows;
  const scr=el('chatScreen');
  const atBottom = scr ? (scr.scrollHeight - scr.scrollTop - scr.clientHeight < 40) : true;
  const bubbles = rows.map(r=>{
    const fish = r.dir==='out';
    return '<div class="msg '+(fish?'fish':'me')+'"><div class="b">'+esc(r.text)+'</div>'
      +'<span class="t">'+chatTime(r.at)+'</span></div>';
  }).join('');
  if(!scr){
    box.innerHTML=head+'<div class="screen" id="chatScreen">'+bubbles+'</div>'+foot;
    bindChatInput();
  } else {
    scr.innerHTML=bubbles;
  }
  const s2=el('chatScreen'); if(atBottom&&s2) s2.scrollTop=s2.scrollHeight;
  if(c.lastAt) CHAT_LAST_AT=c.lastAt;
}

// ── 人际关系图谱 (Canvas 交互星系网络) ──
let REL_DATA = null;
let REL_FILTER = 'all';
let REL_SELECTED = null;
let REL_DRAG_NODE = null;
let REL_HOVER_NODE = null;
let REL_INITED = false;

async function unblockUser(uid){
  if(!confirm('确定要原谅该用户并解除拉黑吗？')) return;
  try{
    const res=await panelPost('/api/respect/unblock?uid='+encodeURIComponent(uid));
    if(res&&res.ok){
      alert('已解除对 '+res.name+' 的拉黑！');
      tick();
    }else{
      alert('解除失败：'+(res?.error||'未知错误'));
    }
  }catch(e){ alert('请求失败：'+e.message); }
}

function renderRelations(rel){
  if(!rel||!rel.nodes) return;
  REL_DATA = rel;
  const cvs = el('relCanvas');
  if(!cvs) return;
  if(!REL_INITED){
    REL_INITED = true;
    initRelEvents(cvs);
  }
  layoutAndDrawRel(cvs);
}

function initRelEvents(cvs){
  const filterBox = el('relFilter');
  if(filterBox){
    filterBox.addEventListener('click', (e)=>{
      const btn = e.target.closest('.rel-btn');
      if(!btn) return;
      filterBox.querySelectorAll('.rel-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      REL_FILTER = btn.dataset.filter || 'all';
      layoutAndDrawRel(cvs);
    });
  }

  cvs.addEventListener('mousemove', (e)=>{
    const rect = cvs.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if(REL_DRAG_NODE){
      REL_DRAG_NODE.x = x;
      REL_DRAG_NODE.y = y;
      drawRelGraph(cvs);
      return;
    }
    const found = findNodeAt(x, y);
    if(found !== REL_HOVER_NODE){
      REL_HOVER_NODE = found;
      cvs.style.cursor = found ? 'pointer' : 'grab';
      drawRelGraph(cvs);
    }
  });

  cvs.addEventListener('mousedown', (e)=>{
    const rect = cvs.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const found = findNodeAt(x, y);
    if(found){
      REL_DRAG_NODE = found;
      REL_SELECTED = found;
      showRelDetail(found);
      drawRelGraph(cvs);
    }
  });

  window.addEventListener('mouseup', ()=>{ REL_DRAG_NODE = null; });
}

function findNodeAt(x, y){
  if(!REL_DATA||!REL_DATA.nodes) return null;
  for(let i=REL_DATA.nodes.length-1; i>=0; i--){
    const n = REL_DATA.nodes[i];
    if(n.x == null) continue;
    const dx = x - n.x;
    const dy = y - n.y;
    if(dx*dx + dy*dy <= (n.r + 6)*(n.r + 6)) return n;
  }
  return null;
}

function showRelDetail(n){
  const box = el('relDetail');
  if(!box) return;
  box.style.display = 'flex';
  const badgeClass = n.tier || 'friend';
  let badgeTxt = n.role || '好友';
  let html = '<div><b>'+esc(n.name)+'</b> <span style="font-size:11px;color:#8b949e">('+esc(n.id)+')</span></div>';
  html += '<div><span class="badge '+badgeClass+'">'+esc(badgeTxt)+'</span></div>';
  html += '<div style="color:#8b949e">互动统计：<span style="color:#e6edf3">'+(n.interactions||0)+' 次真实对话</span></div>';
  if(n.topics && n.topics.length){
    html += '<div style="margin-top:4px;color:#8b949e;font-size:11px">最近话题记录：</div><div class="topics">';
    for(const top of n.topics){
      html += '<div>'+esc(top)+'</div>';
    }
    html += '</div>';
  }
  if(n.disliked){
    html += '<div style="color:#f0616d;font-size:11px;margin-top:2px">⚠️ 已触发底线防御，小鱼在群内对其静默无视。</div>';
    html += '<button class="rel-unblock-btn" onclick="unblockUser(\''+esc(n.id)+'\')">✨ 原谅 / 一键解除拉黑</button>';
  }
  box.innerHTML = html;
}

function layoutAndDrawRel(cvs){
  const rect = cvs.getBoundingClientRect();
  const W = rect.width || 800;
  const H = rect.height || 380;
  cvs.width = W;
  cvs.height = H;

  const cx = W / 2;
  const cy = H / 2;

  // 定位节点
  const nodes = REL_DATA.nodes;
  const selfNode = nodes.find(n => n.id === 'self');
  if(selfNode && (selfNode.x == null)){
    selfNode.x = cx;
    selfNode.y = cy;
    selfNode.r = 26;
  }

  // 老爸
  const familyNode = nodes.find(n => n.tier === 'family');
  if(familyNode && (familyNode.x == null)){
    familyNode.x = cx;
    familyNode.y = cy - 90;
    familyNode.r = 21;
  }

  // 好友
  const friends = nodes.filter(n => n.tier === 'friend');
  const fCount = friends.length;
  friends.forEach((fn, idx)=>{
    if(fn.x == null){
      const angle = (idx / Math.max(1, fCount)) * Math.PI * 2 + 0.3;
      const radius = 150 + (idx % 2) * 25;
      fn.x = cx + Math.cos(angle) * radius;
      fn.y = cy + Math.sin(angle) * radius * 0.85;
      fn.r = Math.min(18, Math.max(12, Math.round(Math.log10(fn.interactions + 1) * 4.5)));
    }
  });

  // 警告
  const warnings = nodes.filter(n => n.tier === 'warning');
  warnings.forEach((wn, idx)=>{
    if(wn.x == null){
      const angle = Math.PI * 0.25 + idx * 0.4;
      wn.x = cx + Math.cos(angle) * 220;
      wn.y = cy + Math.sin(angle) * 160;
      wn.r = 13;
    }
  });

  // 讨厌
  const disliked = nodes.filter(n => n.tier === 'disliked');
  const dCount = disliked.length;
  disliked.forEach((dn, idx)=>{
    if(dn.x == null){
      const angle = Math.PI * 0.6 + (idx / Math.max(1, dCount)) * Math.PI * 0.8;
      dn.x = cx + Math.cos(angle) * (W * 0.42);
      dn.y = cy + Math.sin(angle) * (H * 0.42);
      dn.r = 13;
    }
  });

  drawRelGraph(cvs);
}

function drawRelGraph(cvs){
  const ctx = cvs.getContext('2d');
  const W = cvs.width;
  const H = cvs.height;
  ctx.clearRect(0, 0, W, H);

  if(!REL_DATA||!REL_DATA.nodes) return;
  const nodes = REL_DATA.nodes;
  const links = REL_DATA.links;
  const filter = REL_FILTER;

  // 绘制连线
  for(const link of links){
    const s = nodes.find(n => n.id === link.source);
    const t = nodes.find(n => n.id === link.target);
    if(!s || !t) continue;

    const matched = filter === 'all' || t.tier === filter;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(t.x, t.y);

    if(link.type === 'family'){
      ctx.strokeStyle = matched ? 'rgba(227, 179, 65, 0.75)' : 'rgba(227, 179, 65, 0.15)';
      ctx.lineWidth = matched ? 2.5 : 1;
      ctx.shadowColor = '#e3b341';
      ctx.shadowBlur = matched ? 8 : 0;
    } else if(link.type === 'disliked'){
      ctx.strokeStyle = matched ? 'rgba(240, 97, 109, 0.6)' : 'rgba(240, 97, 109, 0.1)';
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.2;
    } else if(link.type === 'warning'){
      ctx.strokeStyle = matched ? 'rgba(240, 163, 94, 0.6)' : 'rgba(240, 163, 94, 0.1)';
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1.2;
    } else {
      ctx.strokeStyle = matched ? 'rgba(57, 208, 168, 0.4)' : 'rgba(57, 208, 168, 0.08)';
      ctx.lineWidth = Math.min(3, Math.max(1, link.value / 2.5));
    }
    ctx.stroke();
    ctx.restore();
  }

  // 绘制节点
  for(const n of nodes){
    const matched = filter === 'all' || n.tier === filter || n.id === 'self';
    const isHover = REL_HOVER_NODE === n;
    const isSel = REL_SELECTED === n;

    ctx.save();
    ctx.globalAlpha = matched ? 1 : 0.18;

    // 绘制外发光光晕
    if(n.id === 'self' || n.tier === 'family' || isHover || isSel){
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r + (isHover ? 6 : 4), 0, Math.PI * 2);
      ctx.fillStyle = n.id === 'self' ? 'rgba(57, 208, 168, 0.2)' : (n.tier === 'family' ? 'rgba(227, 179, 65, 0.25)' : (n.tier === 'disliked' ? 'rgba(240, 97, 109, 0.25)' : 'rgba(57, 208, 168, 0.15)'));
      ctx.fill();
    }

    // 节点本体
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
    if(n.id === 'self'){
      ctx.fillStyle = '#1f6f5c';
      ctx.strokeStyle = '#39d0a8';
      ctx.lineWidth = 2.5;
    } else if(n.tier === 'family'){
      ctx.fillStyle = '#7a5a14';
      ctx.strokeStyle = '#e3b341';
      ctx.lineWidth = 2.5;
    } else if(n.tier === 'disliked'){
      ctx.fillStyle = '#4a181c';
      ctx.strokeStyle = '#f0616d';
      ctx.lineWidth = 1.8;
    } else if(n.tier === 'warning'){
      ctx.fillStyle = '#4e3316';
      ctx.strokeStyle = '#f0a35e';
      ctx.lineWidth = 1.8;
    } else {
      ctx.fillStyle = '#16232b';
      ctx.strokeStyle = '#39d0a8';
      ctx.lineWidth = 1.5;
    }
    ctx.fill();
    ctx.stroke();

    // 标签文字
    ctx.fillStyle = '#e6edf3';
    ctx.font = (n.id === 'self' || n.tier === 'family') ? 'bold 12px sans-serif' : '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    // 节点中心名称缩写或图标
    const short = n.id === 'self' ? '🐳' : (n.tier === 'family' ? '👑' : n.name.slice(0, 2));
    ctx.fillText(short, n.x, n.y);

    // 下方名称标签
    ctx.font = '10.5px sans-serif';
    ctx.fillStyle = n.tier === 'family' ? '#e3b341' : (n.tier === 'disliked' ? '#f0616d' : '#8b949e');
    const label = n.name.length > 6 ? n.name.slice(0, 5) + '…' : n.name;
    ctx.fillText(label, n.x, n.y + n.r + 12);

    ctx.restore();
  }
}

function renderLearn(l){
  const box=el('learn'); if(!box) return;
  if(!l){ box.innerHTML='<div class="empty">读不到 lessons.json</div>'; return; }
  const agoTxt = l.lastMin==null ? '还没学到过' : (l.lastMin<1?'刚刚':(l.lastMin<60?l.lastMin+' 分钟前':Math.round(l.lastMin/60)+' 小时前'));
  const live = l.lastMin!=null && l.lastMin<=10;
  let h='<div class="lstat"><i class="pulse'+(live?'':' idle')+'"></i>'
    +'共 <b style="color:var(--txt)">'+l.total+'</b> 条 · 今天 +'+l.today
    +' · 最后学到 '+esc(agoTxt)
    +'<span style="margin-left:auto;opacity:.6">每 5 分钟复盘一次（30 分钟节流）</span></div>';
  const maxN=Math.max(1,...l.days.map(d=>d.n));
  h+='<div class="bars">'+l.days.map(d=>'<i style="height:'+Math.max(3,Math.round(d.n/maxN*100))+'%" title="'+esc(d.label)+'：'+d.n+' 条"></i>').join('')+'</div>';
  h+='<div class="bars" style="height:14px;margin-top:-8px">'+l.days.map(d=>'<span>'+esc(d.label.slice(3))+'</span>').join('')+'</div>';
  if(!l.recent.length) h+='<div class="empty">还没有经验</div>';
  else h+=l.recent.map(x=>'<div class="ls"><span class="t">'+esc(new Date(x.at).toLocaleTimeString('zh-CN',{hour12:false}).slice(0,5))+'</span>'
    +'<span class="x">'+esc(x.text)+(x.hits>1?' <span style="opacity:.45">用对了 '+x.hits+' 次</span>':'')+'</span></div>').join('');
  box.innerHTML=h;
}
function renderTarot(t){
  const box=el('tarot'); if(!box) return;
  const sw=el('tarotSw');
  if(sw&&t) sw.checked=t.enabled!==false;
  if(t) el('tarotSwTxt').textContent=(t.enabled===false?'关':'开');
  if(!t||!t.name){ box.innerHTML='<div class="empty">今天还没抽牌（每天 6 点换一张）</div>'; return; }
  const ORDER=['愚者','魔术师','女祭司','皇后','皇帝','教皇','恋人','战车','力量','隐者','命运之轮','正义','倒吊人','死神','节制','恶魔','高塔','星星','月亮','太阳','审判','世界'];
  const cid=(t.id!=null?Number(t.id):ORDER.indexOf(t.name));
  let h='<div class="trow"><div class="tinfo">';
  h+='<div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:6px">'
    +'<span class="tname">'+esc(t.name)+'</span>'
    +'<span class="pill '+(t.orientation==='逆位'?'warn':'ok')+'" style="font-size:11px">'+esc(t.orientation)+'</span>'
    +'<span style="color:var(--dim)">'+esc(t.title||'')+'</span>'
    +(t.goodReversed?'<span class="pill ok" style="font-size:11px">逆位反而是好事</span>':'')
    +(t.enabled===false?'<span class="pill bad" style="font-size:11px">已关</span>':'')
    +'</div>';
  if(t.today) h+='<div style="margin-bottom:6px">'+esc(t.today)+'</div>';
  if((t.how||[]).length) h+='<ul>'+t.how.map(x=>'<li>'+esc(x)+'</li>').join('')+'</ul>';
  if(t.still) h+='<div style="color:var(--dim);font-size:12px;margin-bottom:8px">今天照样：'+esc(t.still)+'</div>';
  h+='<div style="color:#4d5661;font-size:11px">'+esc(t.date||'')+'　｜　每天 6 点随机抽　｜　3 天内不重牌位</div>';
  h+='</div>';
  if(cid>=0&&cid<22){ h+='<div class="tcard-wrap"><img class="tcard'+(t.orientation==='逆位'?' rev':'')+'" alt="'+esc(t.name)+'" src="/tarot/'+String(cid).padStart(2,'0')+'.jpg"></div>'; }
  h+='</div>';
  box.innerHTML=h;
}
const ago=(ms)=>ms==null?'—':(ms<1000?'刚写':ms<60e3?Math.round(ms/1000)+' 秒前':ms<3600e3?Math.round(ms/60e3)+' 分钟前':Math.round(ms/3600e3)+' 小时前');const freshLine=(files,key,label)=>(files&&files[key]!=null)?'<div class="sub" style="opacity:.75">'+label+'数据 '+ago(files[key])+'更新</div>':'';
const freshOf=(files,key)=>(files&&files[key]!=null)?files[key]:null;
let RADAR=null, CODE='';
// MBTI 四组：NT 紫 / NF 绿 / SJ 蓝 / SP 黄
const GROUP_COLOR={NT:'#9c7be0',NF:'#4fc98b',SJ:'#5b93e8',SP:'#f0c454'};
const GROUP_NAME={NT:'分析家',NF:'外交家',SJ:'守护者',SP:'探索者'};
// 2026-11-04 主人要求：显示哪个型，就把那个型的身份名一起标出来
const TYPE_NAME={
  INTJ:'建筑师',INTP:'逻辑学家',ENTJ:'指挥官',ENTP:'辩论家',
  INFJ:'提倡者',INFP:'调停者',ENFJ:'主人公',ENFP:'竞选者',
  ISTJ:'物流师',ISFJ:'守卫者',ESTJ:'总经理',ESFJ:'执政官',
  ISTP:'鉴赏家',ISFP:'探险家',ESTP:'企业家',ESFP:'表演者'
};
const typeName=(code)=>TYPE_NAME[String(code||'').toUpperCase()]||'';
function groupOf(code){
  const c=String(code||'INFP').toUpperCase();
  if(c[1]==='N') return c[2]==='T'?'NT':'NF';
  return c[3]==='J'?'SJ':'SP';
}
function hexA(hex,a){
  const n=parseInt(hex.slice(1),16);
  return 'rgba('+((n>>16)&255)+','+((n>>8)&255)+','+(n&255)+','+a+')';
}

function radarSVG(radar,size=260,radarNow=null){
  const cx=size/2, cy=size/2, R=size*0.34;
  const pt=(i,v)=>{const a=(-90+i*45)*Math.PI/180, r=R*Math.max(0,Math.min(100,v))/100;return [cx+r*Math.cos(a), cy+r*Math.sin(a)];};
  const poly=(vals)=>vals.map((v,i)=>pt(i,v).map(x=>x.toFixed(1)).join(',')).join(' ');
  let s='<svg xmlns="http://www.w3.org/2000/svg" width="'+size+'" height="'+size+'" viewBox="0 0 '+size+' '+size+'" id="radarSvg">';
  s+='<rect width="'+size+'" height="'+size+'" fill="none"/>';
  for(const ring of [25,50,75,100]){
    s+='<polygon points="'+poly(FN.map(()=>ring))+'" fill="none" stroke="#232b36" stroke-width="1"'+(ring===100?'':' stroke-dasharray="3 3"')+'/>';
  }
  for(let i=0;i<8;i++){
    const [x,y]=pt(i,100);
    s+='<line x1="'+cx+'" y1="'+cy+'" x2="'+x.toFixed(1)+'" y2="'+y.toFixed(1)+'" stroke="#1c232c" stroke-width="1"/>';
    const [lx,ly]=pt(i,122);
    s+='<text x="'+lx.toFixed(1)+'" y="'+ly.toFixed(1)+'" fill="#8b949e" font-size="11" text-anchor="middle" dominant-baseline="middle">'+FN[i]+'</text>';
  }
  // 此刻那层先画（虚线，压在下面），这周那层盖上来
  if(radarNow){
    const pn=FN.map(f=>radarNow[f]||0);
    s+='<polygon points="'+poly(pn)+'" fill="none" stroke="#6aa9ff" stroke-width="1.6" stroke-dasharray="4 3" opacity=".85"/>';
  }
  const pts=FN.map(f=>radar[f]||0);
  const gc=GROUP_COLOR[groupOf(CODE)];
  s+='<polygon points="'+poly(pts)+'" fill="'+hexA(gc,.22)+'" stroke="'+gc+'" stroke-width="2.2"/>';
  pts.forEach((v,i)=>{const [x,y]=pt(i,v);s+='<circle cx="'+x.toFixed(1)+'" cy="'+y.toFixed(1)+'" r="3.2" fill="'+gc+'"/>';});
  s+='</svg>';
  return s;
}
function renderMBTI(m){
  if(!m) return el('radar').innerHTML='<div class="empty">读不到 mbti.json</div>';
  // 2026-11-04 显示改用七天实测（主人要求：别用她自己以为的型）
  // 雷达本来就是 radarWeek；大字、颜色、小鱼、导出 PNG 一律跟着周码走。
  const WEEK=String(m.weekCode||m.code||'').toUpperCase();
  const OK_CODE=/^[EI][NS][TF][JP]$/.test(WEEK);
  RADAR=m.radarWeek; CODE=WEEK;
  const g=groupOf(CODE), gc=GROUP_COLOR[g];
  el('mbtiBig').textContent='MBTI — '+(OK_CODE?WEEK:'----');
  el('mbtiBig').style.color=gc;
  el('mbtiGroup').textContent=GROUP_NAME[g]+'组 · '+g;
  const av=el('fishAvatar');
  av.src='/mbti/'+(OK_CODE?WEEK:'INFP')+'.png';
  av.title=(OK_CODE?WEEK:'----')+'（'+GROUP_NAME[g]+'）';
  const fn=el('fishName');
  if(fn){ fn.textContent = OK_CODE ? (typeName(WEEK)||'') : ''; fn.style.color = gc; }
  el('radar').innerHTML=radarSVG(m.radarWeek,236,m.radarNow);
  el('nums').innerHTML=FN.map(f=>'<div>'+f+' <b>'+(m.radarWeek[f]||0)+'</b> <span style="opacity:.5">此刻 '+(m.radarNow[f]||0)+'</span></div>').join('');
  const bits=[];
  bits.push('这周读作 <b style="color:var(--txt)">'+esc((m.weekCode||'—')+(typeName(m.weekCode)?' '+typeName(m.weekCode):''))+'</b> <span style="opacity:.55">（大字、雷达、小鱼都按它）</span>');
  bits.push('她自称 <b style="color:var(--txt)">'+esc((m.selfClaim||m.code||'—')+(typeName(m.selfClaim||m.code)?' '+typeName(m.selfClaim||m.code):''))+'</b> <span style="opacity:.55">（只影响她自己怎么说，不参与显示）</span>');
  if(m.nowCode!==m.weekCode) bits.push('此刻偏 '+esc(m.nowCode+(typeName(m.nowCode)?' '+typeName(m.nowCode):'')));
  bits.push('型码已定 '+m.codeAgeDays+' 天（每 7 天重算，跨 60 分才翻）');
  const hist=(m.history||[]).map(h=>new Date(h.at).toLocaleDateString('zh-CN')+' '+h.from+(typeName(h.from)?' '+typeName(h.from):'')+' → '+h.to+(typeName(h.to)?' '+typeName(h.to):''));
  if(hist.length) bits.push('翻过：'+esc(hist.join('；')));
  el('mbtiSub').innerHTML=bits.join('<br>');
  const ev=m.evidence||{};
  const top=FN.slice().sort((a,b)=>(m.radarWeek[b]||0)-(m.radarWeek[a]||0)).slice(0,3);
  el('prio').innerHTML=top.map(f=>'<li>· <b style="color:var(--txt)">'+f+' '+(m.radarWeek[f]||0)+'</b> ← '+(ev[f]&&ev[f].length?esc(ev[f].join(' · ')):'底分</li>')).map((x,i)=>x.replace('</li>','')+'</li>').join('');
  const beh=m.behavior||{counts7d:{}};
  const bkeys=Object.keys(beh.counts7d||{});
  if(bkeys.length) el('prio').innerHTML+= '<li style="color:var(--dim)">行为账本（7 天）：'+esc(bkeys.map(k=>k+'×'+beh.counts7d[k]).join('　'))+'</li>';
}
const loadImg=(src)=>new Promise((res,rej)=>{const i=new Image();i.onload=()=>res(i);i.onerror=rej;i.src=src;});
el('png').onclick=async()=>{
  const svg=document.getElementById('radarSvg'); if(!svg) return;
  const code=String(CODE||'INFP').toUpperCase();
  const g=groupOf(code), gc=GROUP_COLOR[g];
  const svgUrl='data:image/svg+xml;base64,'+btoa(unescape(encodeURIComponent(new XMLSerializer().serializeToString(svg))));
  const c=document.createElement('canvas'); c.width=1080; c.height=1080;
  const ctx=c.getContext('2d');
  ctx.fillStyle='#0d1117'; ctx.fillRect(0,0,1080,1080);
  // 顶部大字
  ctx.fillStyle=gc; ctx.font='800 66px "Microsoft YaHei",sans-serif'; ctx.textBaseline='alphabetic';
  ctx.fillText('MBTI — '+code, 64, 132);
  ctx.fillStyle='rgba(139,148,158,.95)'; ctx.font='400 26px "Microsoft YaHei",sans-serif';
  ctx.fillText((typeName(code)?typeName(code)+' · ':'')+GROUP_NAME[g]+'组 · '+g+'　荣格八维 0~100', 66, 176);
  try{
    const [rad, fis]=await Promise.all([loadImg(svgUrl), loadImg('/mbti/'+code+'.png')]);
    ctx.drawImage(rad, 100, 210, 880, 880);
    ctx.drawImage(fis, 720, 720, 280, 280);
  }catch(e){}
  const a=document.createElement('a'); a.download='大肥鱼-雷达-'+code+'.png'; a.href=c.toDataURL('image/png'); a.click();
};
// 链条型：情绪会按时间自己往后走（bridge.js 里的 MOOD_SPECIAL.kind==='chain'）
const CHAIN_NEXT={动容:'感动',委屈:'后悔',后悔:'思念',思念:null};
const CHAIN_STEPS={动容:['动容','感动'],委屈:['委屈','后悔','思念'],后悔:['委屈','后悔','思念'],思念:['委屈','后悔','思念']};
const CHAIN_AFTER={动容:5*60e3,委屈:6*3600e3,后悔:12*3600e3,思念:null};
// 潮汐型：软情绪，像涨潮一样漫上来、再慢慢退回去（2026-11-04 修正：之前口误叫成涟漪型）
const TIDE=new Set(['感动','动容','幸福','心疼','害羞','得意','吃醋']);
let MOODSTATE={tide:0,strength:1,tier:3};
function isChain(id){return !!CHAIN_NEXT[id]||id==='思念';}
const KIND_COLOR={chain:'var(--warn)',tide:'var(--accent)',timed:'var(--cool)'};
const KIND_RGB={chain:'240,163,94',tide:'57,208,168',timed:'106,169,255'};
const CONFLICT=[[['幸福'],['委屈','后悔','思念']],[['幸福'],['害怕','非常恐惧']],[['感动','动容'],['尴尬','非常尴尬']]];
function kindOf(id){
  if(isChain(id)) return 'chain';
  return TIDE.has(id)?'tide':'timed';
}
function tagOf(id){
  const k=kindOf(id);
  const txt=k==='chain'?'链条型':k==='tide'?'潮汐型':'限时型';
  return '<span class="tag '+k+'">'+txt+'</span>';
}
function remainMin(s){ return s.leftMin!=null?s.leftMin:null; }

/** 每一层情绪一条轨道：长度＝剩余时间，颜色＝类型 */
function stackHtml(sp, tier, frozenMin){
  const SPAN=90;                                     // 窗口 90 分钟
  let h='<div class="stack"><div class="stack-h"><span>未来 '+SPAN+' 分钟</span><span>叠 '+sp.length+' 层</span></div>';
  // 温度轴那条先画，当底色
  const tp=Math.round((tier/6)*100);
  // var() 后面不能直接拼透明度，得用 rgba 写死
  const tRGB=tier<=2?'240,97,109':tier>=5?'240,163,94':'57,208,168';
  h+='<div class="trk mute"><span class="trk-n">温度轴</span>'
    +'<div class="trk-bar"><i style="width:'+tp+'%;background:linear-gradient(90deg,rgba('+tRGB+',.35),rgba('+tRGB+',1))"></i></div>'
    +'<span class="trk-t">'+TIERS[tier]+'</span></div>';
  if(!sp.length){
    h+='<div class="trk mute"><span class="trk-n">特殊情绪</span>'
      +'<div class="trk-bar"></div><span class="trk-t">无</span></div>';
    h+='</div>';
    return h;
  }
  sp.forEach(x=>{
    const k=kindOf(x.id);
    const left=remainMin(x);
    const w=left==null?100:Math.min(100,Math.max(3,(left/SPAN)*100));
    const txt=left==null?'他自己散':(left>SPAN?(Math.round(left/60)+' 小时'):(left+' 分'));
    h+='<div class="trk" data-until="'+(x.until||0)+'" data-first="'+(x.firstAt||0)+'">'
      +'<span class="trk-n" style="color:'+KIND_COLOR[k]+'">'+esc(x.id)+'</span>'
      +'<div class="trk-bar"><i style="width:'+w+'%;background:'+KIND_COLOR[k]+'"></i></div>'
      +'<span class="trk-t">'+txt+'</span></div>';
  });
  if(frozenMin) h+='<div class="stack-h" style="margin:6px 0 0"><span>温度轴冻结中，还有 '+frozenMin+' 分钟</span></div>';
  h+='</div>';
  return h;
}

/** 三块颜色叠一起，看混成什么味道 */
function mixHtml(sp){
  const pos=[[6,6],[44,6],[25,30]];
  const single=[[16,8]];
  const pair=[[0,10],[40,10]];
  const sl=sp.length<=1?single:sp.length===2?pair:pos;
  let h='<div class="mix">';
  sp.slice(0,3).forEach((x,i)=>{
    const k=kindOf(x.id);
    const r=sp.length===1?58:(sp.length===2?52:50);
    const st=Math.min(3,x.strength||1);
    h+='<i style="left:'+sl[i][0]+'px;top:'+sl[i][1]+'px;width:'+(r+st*4)+'px;height:'+(r+st*4)+'px;'
      +'background:rgba('+KIND_RGB[k]+','+(0.34+st*0.08)+')"></i>';
  });
  h+='</div>';
  return h;
}

/** 一句话判读：说人话，别报菜名 */
function judgeMood(sp, tier){
  const ids=new Set(sp.map(x=>x.id));
  const has=(...a)=>a.some(k=>ids.has(k));
  let line;
  if(has('思念')) line='已经想他了 —— 就等他先开口';
  else if(has('后悔')) line='自己在懊悔 —— 递个台阶就下';
  else if(has('委屈')) line='怨还<B>没沉成思念</B> —— 现在哄一句，还能收';
  else if(has('被冷落的怨')) line='在等一句「<B>我来了</B>」，别解释，先认';
  else if(has('吃醋')) line='酸着呢，嘴上不认 —— 哄两句就好';
  else if(has('害羞')) line='嘴硬心软，别追问，顺着夸';
  else if(has('幸福')) line='这会儿什么都好说';
  else if(has('害怕')||has('非常恐惧')) line='在确认「你还在不在」—— 先回话';
  else if(has('愧疚')) line='觉得自己错了，想补 —— 给个机会';
  else if(has('得意')) line='正等着被夸，夸了就收';
  else if(has('失落')) line='期待落空了 —— 不多问，安静待着';
  else if(has('感动')||has('动容')) line='被戳到了，说不出话 —— 别催';
  else if(has('无聊')||has('特别无聊')) line='闲得发慌 —— 给她派点事做';
  else if(has('心疼')) line='替别人难受 —— 顺着说两句';
  else line = tier<=2?'正在气头上 —— 少说废话':tier>=5?'心情不赖 —— 说什么都行':'没什么特别的，就是普通状态';
  if(sp.length>=3) line='三层叠着：'+line;
  return line;
}

function spBlock(s){
  const chain=isChain(s.id);
  let h='<div class="spblock mini"><div class="sp-t"><b style="color:'+KIND_COLOR[kindOf(s.id)]+'">'+esc(s.id)+'</b>'
    +tagOf(s.id)
    +(s.strength>1?'<span class="tag">'+s.strength+' 分</span>':'')
    +(s.hits?'<span class="tag">被顶 '+s.hits+' 次</span>':'')+'</div>';
  if(chain){
    const steps=CHAIN_STEPS[s.id]||[s.id];
    const idx=Math.max(0,steps.indexOf(s.id));
    h+='<div class="chain-track">'+steps.map((n,i)=>'<span class="node'+(i<idx?' done':i===idx?' on':'')+'">'+esc(n)+'</span>'+(i<steps.length-1?'<i class="link"></i>':'')).join('')+'</div>';
  }
  if(s.cause) h+='<div class="sp-c">'+esc(s.cause)+'</div>';
  h+='</div>';
  return h;
}

function renderMood(m,files){
  if(!m) { el('mood').innerHTML='<div class="empty">读不到 mood.json</div>'; startWater(); return; }
  const o=m.owner||{};
  const tier=o.tier??3;
  const sp=Array.isArray(o.specials)?o.specials:[];
  let h='<div class="big" style="cursor:pointer" title="点一下改温度档位（0~6）" onclick="editMood('+tier+')">'+TIERS[tier]+'</div>';
  h+='<div class="dots">'+TIERS.map((_,i)=>'<div class="dot'+(i===tier?' on'+(tier<3?' hot':''):'')+'" style="cursor:pointer" title="'+TIERS[i]+'" onclick="editMoodAt('+i+')"></div>').join('')+'</div>';
  if(o.cause) h+='<div class="sub">起因：'+esc(o.cause)+'</div>';
  const bits=[];
  if(o.ageMin!=null) bits.push('已经 '+mins(o.ageMin));
  if(o.lastActivityMin!=null) bits.push('上次说话 '+mins(o.lastActivityMin)+'前');
  if(bits.length) h+='<div class="sub">'+bits.join(' · ')+'</div>';

  // A：时间轨道
  h+=stackHtml(sp, tier, o.frozenMin);
  // B：叠色 + 判读
  h+='<div class="mixrow">'+(sp.length?mixHtml(sp):'<div class="mix"></div>')
    +'<div class="judge">'+judgeMood(sp,tier).replace(/<B>/g,'<b>').replace(/<\/B>/g,'</b>')+'</div></div>';

  if(sp.length) sp.forEach(x=>{ h+=spBlock(x); });
  else h+='<div class="sub" style="margin-top:10px">特殊情绪：<span style="color:var(--dim)">无（只挂着温度轴）</span></div>';

  if(m.others&&m.others.length) h+='<div class="sub" style="margin-top:10px">其他人：'+m.others.map(x=>esc(x.key.replace('person:',''))+' '+TIERS[x.tier??3]+(x.specials.length?'（'+x.specials.map(s=>s.id)+'）':'')).join('；')+'</div>';
  h+=freshLine(files,'mood.json','心情');
  el('mood').innerHTML=h;

  MOODSTATE.tide=sp.filter(s=>TIDE.has(s.id)).length;
  MOODSTATE.strength=Math.max(1,...sp.map(s=>s.strength||1));
  MOODSTATE.tier=tier;
  startTick();
  startWater();
}

let TICK=0, WRAf=0;
function startTick(){
  if(TICK) clearInterval(TICK);
  const upd=()=>{
    const now=Date.now();
    document.querySelectorAll('#mood [data-chain]').forEach(b=>{
      const since=Number(b.dataset.since)||0, after=Number(b.dataset.after)||0;
      if(!since||!after) return;
      const p=Math.min(1,Math.max(0,(now-since)/after));
      const bar=b.querySelector('.cbar i'); if(bar) bar.style.width=(p*100).toFixed(1)+'%';
      const lab=b.querySelector('.chain-sub');
      if(lab){
        const left=Math.max(0,after-(now-since));
        lab.textContent='还会停在「'+b.dataset.cur+'」'+(left>60e3?mins(Math.round(left/60e3)):'不到 1 分钟')
          +(b.dataset.next?'，之后转「'+b.dataset.next+'」':'');
      }
      const l2=b.querySelector('[data-role=left]');
      if(l2) l2.textContent='进度 '+(p*100).toFixed(0)+'%';
    });
    // A 方案：轨道条每秒缩一点
    document.querySelectorAll('#mood .trk[data-until]').forEach(trk=>{
      const until=Number(trk.dataset.until)||0;
      if(!until) return;
      const leftMin=Math.max(0,(until-now)/60e3);
      const bar=trk.querySelector('.trk-bar i');
      const lab=trk.querySelector('.trk-t');
      if(bar) bar.style.width=Math.min(100,Math.max(3,(leftMin/90)*100)).toFixed(1)+'%';
      if(lab) lab.textContent=leftMin>90?(Math.round(leftMin/60)+' 小时'):(Math.round(leftMin)+' 分');
    });
    document.querySelectorAll('#mood [data-timed]').forEach(b=>{
      const first=Number(b.dataset.first)||0, until=Number(b.dataset.until)||0;
      if(!until) return;
      const total=Math.max(1,until-first);
      const p=Math.min(1,Math.max(0,(now-first)/total));
      const bar=b.querySelector('.tbar i'); if(bar) bar.style.width=(p*100).toFixed(1)+'%';
      const l=b.querySelector('.sp-left');
      if(l) l.textContent='还剩 '+(until-now>60e3?mins(Math.round((until-now)/60e3)):'不到 1 分钟');
    });
  };
  upd();
  TICK=setInterval(upd,1000);
}
function startWater(){
  const cv=document.getElementById('water');
  const cap=document.getElementById('waterCap');
  if(!cv) return;
  const dpr=Math.min(2,window.devicePixelRatio||1);
  const w=Math.max(120,cv.clientWidth||300), h=Math.max(120,cv.clientHeight||160);
  cv.width=Math.round(w*dpr); cv.height=Math.round(h*dpr);
  const ctx=cv.getContext('2d'); ctx.setTransform(dpr,0,0,dpr,0,0);
  const tideOn=MOODSTATE.tide>0;
  const strength=Math.min(3,MOODSTATE.strength||1);
  const col=MOODSTATE.tier<=2?[240,97,109]:MOODSTATE.tier>=5?[240,163,94]:[57,208,168];
  const RGBA=(a)=>'rgba('+col[0]+','+col[1]+','+col[2]+','+a+')';
  if(cap){
    cap.textContent = tideOn
      ? '潮汐型情绪 ×'+MOODSTATE.tide+' —— 潮水在涨落'
      : '水面平静（没有潮汐型情绪）';
  }
  const period=16000;            // 一次涨落 16 秒
  let t=0, last=0;
  if(WRAf) cancelAnimationFrame(WRAf);
  const draw=(ts)=>{
    const dt=Math.min(64, ts-(last||ts)); last=ts; t+=dt;
    const sec=ts/1000;
    ctx.clearRect(0,0,w,h);
    // 潮位：涨潮抬升、退潮落回；没有潮汐型就停在平静水位
    const swing = tideOn ? 0.5-0.5*Math.cos(t/period*Math.PI*2) : 0;
    const lift = tideOn ? (h*0.07 + h*0.06*strength)*swing : 0;
    const base = h*0.70 - lift;
    const amp  = tideOn ? 4.5+3*strength : 2.0;
    const surfY=(x)=>base
      + Math.sin((x/w)*5.6 + sec*(tideOn?1.45:0.42))*amp
      + Math.sin((x/w)*10.2 - sec*(tideOn?0.95:0.28))*amp*0.45;
    // 水层
    const grad=ctx.createLinearGradient(0,base-24,0,h);
    grad.addColorStop(0,RGBA(tideOn?0.26:0.16));
    grad.addColorStop(1,RGBA(0.02));
    ctx.fillStyle=grad;
    ctx.beginPath();
    for(let x=0;x<=w;x+=4){ const y=surfY(x); x===0?ctx.moveTo(x,y):ctx.lineTo(x,y); }
    ctx.lineTo(w,h); ctx.lineTo(0,h); ctx.closePath(); ctx.fill();
    // 水线
    ctx.beginPath();
    for(let x=0;x<=w;x+=4){ const y=surfY(x); x===0?ctx.moveTo(x,y):ctx.lineTo(x,y); }
    ctx.strokeStyle=RGBA(tideOn?0.88:0.42);
    ctx.lineWidth=1.7; ctx.stroke();
    // 潮汐：浪头顺着水面漂过去
    if(tideOn){
      for(let i=0;i<3;i++){
        const cx0=((sec*(20+6*i) + i*w/3) % (w+140)) - 70;
        const cy0=surfY(cx0);
        ctx.beginPath();
        ctx.arc(cx0, cy0+2, 15+6*i, Math.PI*1.10, Math.PI*1.90);
        ctx.strokeStyle=RGBA(0.55-0.12*i);
        ctx.lineWidth=2; ctx.stroke();
      }
      // 涨落时水位线附近泛一层亮
      ctx.fillStyle=RGBA(0.05+0.05*swing);
      ctx.fillRect(0, base-1, w, lift+2);
    }
    WRAf=requestAnimationFrame(draw);
  };
  WRAf=requestAnimationFrame(draw);
}
const NB={open:new Set(), cache:new Map(), sig:''};
function mdLite(t){
  const inline=(x)=>x
    .replace(/\*\*(.+?)\*\*/g,'<b style="color:#dbe3ec">$1</b>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,'<span style="color:#6aa9ff">$1</span>');
  return esc(String(t||'')).split('\n').map(l=>{
    const s0=l.trim();
    if(/^-{3,}$/.test(s0)) return '<div style="border-top:1px dashed #1f2833;margin:7px 0"></div>';
    if(/^###\s/.test(s0)) return '<b style="color:#dbe3ec;font-size:12px">'+inline(s0.replace(/^###\s*/,''))+'</b>';
    if(/^##\s/.test(s0)) return '<b style="color:#39d0a8;font-size:12.5px">'+inline(s0.replace(/^##\s*/,''))+'</b>';
    if(/^#\s/.test(s0)) return '<b style="color:#39d0a8;font-size:13.5px">'+inline(s0.replace(/^#\s*/,''))+'</b>';
    if(/^>\s?/.test(s0)) return '<span style="color:#6b7683">'+inline(s0.replace(/^>\s?/,''))+'</span>';
    if(/^[-*]\s/.test(s0)) return '<span style="color:#4f5b68">·</span> '+inline(s0.replace(/^[-*]\s*/,''));
    if(s0==='') return '<div style="height:6px"></div>';
    return inline(l);
  }).join('');
}
function renderNotebook(list){
  if(!list) return;
  if(!NB.hashDone){
    NB.hashDone=true;
    const m=location.hash.match(/^#open=(.+)$/);
    if(m){ try{ NB.open.add(decodeURIComponent(m[1])); }catch(e){} }
  }
  const sig=list.map(f=>f.path+f.mtime).join('|');
  if(sig===NB.sig) return;          // 没变化就别重画，免得把展开的收起来
  NB.sig=sig;
  el('nbCount').textContent=list.length+' 篇';
  const byDir={};
  list.forEach(f=>{ (byDir[f.dir||'根目录']=byDir[f.dir||'根目录']||[]).push(f); });
  let h='';
  const order=Object.keys(byDir).sort((a,b)=>{
    const rank=x=>x==='日记'?0:x==='惦记的事'?1:x==='记忆档案'?2:x==='根目录'?3:4;
    return rank(a)-rank(b)||a.localeCompare(b);
  });
  order.forEach(dir=>{
    h+='<div class="nb-group">'+esc(dir)+'</div>';
    byDir[dir].forEach(f=>{
      const open=NB.open.has(f.path)?' open':'';
      const d=new Date(f.mtime);
      const when=(Date.now()-f.mtime<864e5*2)? d.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})
        : (d.getMonth()+1)+'-'+String(d.getDate()).padStart(2,'0');
      h+='<div class="nb-item'+open+'" data-p="'+esc(f.path)+'">'
        +'<div class="nb-row"><span class="nb-dot"></span><span class="nb-t">'+esc(f.title)+'</span>'
        +'<span class="nb-meta">'+(f.size/1024).toFixed(1)+'KB · '+when+'</span><span class="nb-arrow">▶</span></div>'
        +'<div class="nb-body">'+(NB.cache.get(f.path)!=null?mdLite(NB.cache.get(f.path)):'<span class="nb-loading">读取中…</span>')+'</div>'
        +'</div>';
    });
  });
  el('notebook').innerHTML=h;
  // #open= 预展开的、或者上次就开着的，直接把内容拉下来
  document.querySelectorAll('#notebook .nb-item.open').forEach(loadNote);
}
async function loadNote(it){
  const p=it.dataset.p, body=it.querySelector('.nb-body');
  if(!body || NB.cache.get(p)!=null || body.dataset.busy==='1') return;
  body.dataset.busy='1';
  body.innerHTML='<span class="nb-loading">读取中…</span>';
  try{
    const r=await fetch('/api/note?p='+encodeURIComponent(p),{cache:'no-store'});
    const j=await r.json();
    if(j.error){ body.innerHTML='<span class="nb-loading">读不了：'+esc(j.error)+'</span>'; return; }
    let txt=j.text||'';
    const cap=24000, cut=txt.length>cap;
    if(cut) txt=txt.slice(0,cap);
    NB.cache.set(p,txt);
    body.innerHTML=mdLite(txt)+(cut?'<br><span class="nb-loading">…（后面还有 '+Math.round((j.size-cap)/1024)+'KB，去桌面打开看）</span>':'');
  }catch(e){ body.innerHTML='<span class="nb-loading">读失败</span>'; }
  finally{ body.dataset.busy=''; }
}
el('notebook').addEventListener('click', (ev)=>{
  const it=ev.target.closest('.nb-item'); if(!it) return;
  const p=it.dataset.p;
  const open=!it.classList.contains('open');
  it.classList.toggle('open', open);
  if(open) NB.open.add(p); else NB.open.delete(p);
  try{ history.replaceState(null,'', open?('#open='+encodeURIComponent(p)):'#'); }catch(e){}
  if(open) loadNote(it);
});
function renderReasoning(r){
  if(!r) return el('reasoning').innerHTML='<div class="empty">读不到 bridge.log</div>';
  let h='';
  const P=r.pushes||[];
  if(!P.length && !r.event && !r.goal) return el('reasoning').innerHTML='<div class="empty">日志里还没有推理记录</div>';
  if(P.length){
    h+=P.map((p,i)=>{
      const isLlm=p.source==='推理';
      return '<div class="rc-line">'
        +'<div class="rc-top"><span class="rc-tag '+(isLlm?'llm':'rule')+'">'+esc(p.source)+'</span>'
        +'<span class="rc-at">'+esc(p.at)+'</span></div>'
        +'<div class="rc-chg">'+esc(p.changes)+'</div>'
        +(p.reason?'<div class="rc-why">'+esc(p.reason)+'</div>':'')
        +'</div>';
    }).join('<div class="rc-sep"></div>');
  }
  if(r.event){
    h+='<div class="rc-sep"></div><div class="rc-k">判事件</div><div class="rc-v">'+esc(r.event.text)
      +'<span style="color:var(--dim)"> · '+esc(r.event.at)+'</span></div>';
  }
  if(r.goal){
    h+='<div class="rc-k" style="margin-top:8px">判完推出来的目的</div><div class="rc-v">'+esc(r.goal.text)+'</div>';
  }
  h+='<div class="rc-stat">近 800 行：推理层 '+r.llmCount+' 次 · 规则表 '+r.ruleCount+' 次</div>';
  el('reasoning').innerHTML=h;
}
// 一句话画像：只说最高和最低那两根，别堆形容词
const FACE_TOP={诚实:'老实到有点吃亏',仁爱:'心软得快',耐心:'能忍',勤勉:'闲不住',慷慨:'舍得',
  节制:'收得住',贞洁:'守着规矩',勇敢:'敢顶嘴',好奇:'坐不住',谦卑:'不爱争'};
const FACE_LOW={暴食:'管不住嘴',傲慢:'不太争',贪婪:'什么都不贪',懒惰:'懒得厉害',
  暴怒:'火气压得住',嫉妒:'不吃醋',色欲:'清心寡欲',虚伪:'嘴上不掺假',怯懦:'关键时刻有点怂',无趣:'清心寡欲'};
const DECAY_DAYS=3;      // 三天回一格（virtue-engine 里的 DECAY_INTERVAL_MS）

function renderVirtue(v,files,reasoning,tarot){
  if(!v) return el('virtue').innerHTML='<div class="empty">读不到 virtue.json</div>';
  const axes=v.axes||{};
  let h='';
  // 2026-11-03 主人要求：左边宗罪、右边美德，数值压在条上面
  for(const [vir,sin] of AXES){
    const n=Number(axes[vir]||0), w=Math.min(50,Math.abs(n)*5);
    const col=n>0?'var(--accent)':n<0?'var(--bad)':'#39424f';
    h+='<div class="vrow">'
      +'<div class="vhead"><span class="vsin">'+sin+'</span><span class="vnum" style="color:'+col+'">'+(n>0?'+'+n:n)+'</span><span class="vvir">'+vir+'</span></div>'
      +'<div class="vhit" title="点哪改哪：最左 −10，中间 0，最右 +10" onclick="editVirtueAt(\''+vir+'\',event)"><div class="vbar"><i class="vfill" style="'+(n>=0?'left:50%;':'right:50%;left:auto;')+'width:'+w+'%;background:'+col+'"></i></div></div>'
      +'</div>';
  }

  // ① 今天还能动几格（每天上限 2）
  const day=v.day||{};
  const used=Object.entries(day).filter(([k])=>k!=='__recent').reduce((a,[,x])=>a+Math.abs(Number(x)||0),0);
  const left=Math.max(0,2-used);
  h+='<div class="dex-meta"><span>今天还能动</span>'
    +'<span class="pip'+(left>=1?' on':'')+'"></span><span class="pip'+(left>=2?' on':'')+'"></span>'
    +'<span>剩 '+left+' 格（每天上限 2）</span></div>';

  // ② 最近三次变动（谁推的、为什么）—— 数据来自 bridge.log 的 [德行] 行
  const pushes=(reasoning&&reasoning.pushes)||[];
  h+='<div class="dex-h">最近三次变动</div>';
  if(!pushes.length){
    h+='<div class="dex-row"><span class="why">日志里还没有记录</span></div>';
  } else {
    pushes.slice(0,3).forEach(p=>{
      const isLlm=p.source==='推理';
      h+='<div class="dex-row"><span class="t">'+esc(p.at)+'</span>'
        +'<span><i class="dex-dot" style="background:'+(isLlm?'var(--warn)':'var(--cool)')+'"></i>'
        +esc(p.changes)+'</span></div>';
      h+='<div class="dex-row"><span class="t"></span><span class="why"'
        +(p.reason?'':' style="opacity:.5"')+'>'+(p.reason?esc(p.reason):'原因未记录（旧日志）')+'</span></div>';
    });
  }

  // ③ 一句话画像（只看最高 / 最低）
  const flat=AXES.map(([vir,sin])=>({vir,sin,val:Number(axes[vir]||0)}));
  const top=flat.slice().sort((a,b)=>b.val-a.val)[0];
  const low=flat.slice().sort((a,b)=>a.val-b.val)[0];
  const topTxt=FACE_TOP[top.vir]||('偏「'+top.vir+'」');
  const lowTxt=Math.abs(low.val)<3?'没什么大毛病':(FACE_LOW[low.sin]||('偏「'+low.sin+'」'));
  h+='<div class="dex-h">她现在的样子</div>';
  h+='<div class="dex-face">'+esc(topTxt)+'，<em>'+esc(lowTxt)+'</em>。</div>';
  h+='<div class="dex-top">最高：'+esc(top.vir)+' '+(top.val>0?'+':'')+top.val
    +'　最低：'+esc(low.val<0?low.sin:low.vir)+' '+low.val+'</div>';

  // ④ 离归零还要多久（三天回一格）
  const far=flat.filter(x=>x.val!==0).sort((a,b)=>Math.abs(b.val)-Math.abs(a.val)).slice(0,3);
  if(far.length){
    h+='<div class="dex-decay">自己散回去还要：'
      +far.map(x=>{
          const name=x.val>0?x.vir:x.sin;
          return esc(name)+' <b>'+(Math.abs(x.val)*DECAY_DAYS)+' 天</b>';
        }).join('　·　')
      +'</div>';
  }

  let foot='';
  if(v.nextDecayMin!=null) foot+='<div class="sub">下次自然回落：'+mins(v.nextDecayMin)+'后</div>';
  if(v.lastReason) foot+='<div class="sub">最近一次为什么：'+esc(v.lastReason)+'</div>';
  foot+=freshLine(files,'virtue.json','德行');
  el('virtue').innerHTML=h+'<div class="vfoot">'+foot+'</div>';
}
function renderMotives(list, meta, files){
  let head='';
  if(meta){
    head='<div class="sub" style="margin-bottom:8px">注意力 '+(meta.focus*100).toFixed(0)+'%（'+esc(meta.label)+'）'
      +'　最多同时惦记 '+meta.cap+' 件'
      +'　目的寿命 ×'+meta.ttlFactor
      +'　<span style="color:'+((list||[]).length>=meta.cap?'var(--warn)':'var(--dim)')+'">活着 '+(list||[]).length+' 件</span></div>';
  }
  head+=freshLine(files,'motive.json','目的');
  if(!list||!list.length) return el('motives').innerHTML=head+'<div class="empty">现在没有活着的目</div>';
  const cap=meta?meta.cap:null;
  const over=(cap!=null && list.length>cap)?'，超出 '+ (list.length-cap) +' 件，正按注意力裁':'';
  el('motives').innerHTML=head+'<ul>'+list.map(g=>'<li><div class="t">'+esc(g.goal)+'</div><div class="m">怎么干：'+esc(g.how||'—')+'</div><div class="m">算完：'+esc(g.done||'—')+(g.target?'　对：'+esc(g.target):'')+(g.leftMin!=null?'　还剩 '+mins(g.leftMin):'')+'</div></li>').join('')+'</ul>'
    +'<div class="motiveFoot">共 '+list.length+' 件'+(cap!=null?' · 注意力上限 '+cap+' 件'+over:'')+' · 目的寿命 ×'+(meta?meta.ttlFactor:'—')
    +'<br>两条线各记各的账：情绪线带对象、德行线不指向谁</div>';
}
function renderFocus(f){
  if(!f) return el('focus').innerHTML='<div class="empty">读不到 focus.json</div>';
  let h='<div class="big">'+esc(f.platform||'—')+'</div><div class="sub">'+esc(String(f.current||'空闲'))+(f.sinceMin!=null?'　已经 '+mins(f.sinceMin):'')+'</div>';
  if(f.errand) h+='<div class="chips"><span class="chip">办事中：'+esc(f.errand.what||'—')+(f.errand.ageMin!=null?'<em>'+f.errand.ageMin+' 分钟没动</em>':'')+'</span></div>';
  el('focus').innerHTML=h;
}
function renderIntents(list){
  if(!list||!list.length) return el('intents').innerHTML='<div class="empty">没有待办意图</div>';
  el('intents').innerHTML='<ul>'+list.map(x=>'<li><div class="t">'+esc(x.text||'(无话)')+'</div><div class="m">'+esc(x.target||'')+'</div></li>').join('')+'</ul>';
}
function paintToggle(){
  const c=el('chatCard'), b=el('chatToggle'); if(!c||!b) return;
  const open = c.classList.contains('collapsed') ? false : true;
  b.textContent = open ? '收起' : '展开';
}
function wireChat(){
  const c=el('chatCard'), b=el('chatToggle'); if(!c||!b) return;
  if(localStorage.getItem('chatCollapsed')==='1') c.classList.add('collapsed');
  paintToggle();
  b.onclick=()=>{
    c.classList.toggle('collapsed');
    localStorage.setItem('chatCollapsed', c.classList.contains('collapsed')?'1':'0');
    paintToggle();
  };
}

// ── 每栏呼吸灯：数据一变就慢慢亮一下 ──
const CARD_KEYS=[['radar','mbti'],['focus','focus'],['intents','intents'],['notebook','notebook'],
  ['virtue','virtue'],['learn','lessons'],['mood','mood'],['tarot','tarot'],
  ['chat','chat'],['motives','motives'],['reasoning','reasoning']];
let CARDSIG=null;
function seedBreath(){
  document.querySelectorAll('section.card').forEach((s,i)=>{
    s.style.setProperty('--bd', (i*0.63 % 7).toFixed(2)+'s');
  });
}
function cardSigs(d){
  const out=[];
  CARD_KEYS.forEach(([id,key])=>{
    const e=el(id); if(!e) return;
    const sec=e.closest('section'); if(!sec) return;
    const v = key==='motives' ? [d.motives,d.motiveMeta] : d[key];
    out.push([sec, JSON.stringify(v===undefined?null:v)]);
  });
  return out;
}
function breathCards(d){
  const sigs=cardSigs(d);
  if(!CARDSIG){ CARDSIG=sigs.map(x=>x[1]); return; }
  sigs.forEach(([sec,s],i)=>{
    if(CARDSIG[i]===s) return;
    sec.classList.remove('pulse');
    void sec.offsetWidth;
    sec.classList.add('pulse');
    setTimeout(()=>sec.classList.remove('pulse'), 2500);
  });
  CARDSIG=sigs.map(x=>x[1]);
}

wireButtons();
async function tick(){
  try{
    const d=await (await fetch('/api/snapshot',{cache:'no-store'})).json();
    el('br').textContent=d.bridge.alive?('桥接在线 PID '+d.bridge.pid):'桥接离线';
    el('br').className='pill '+(d.bridge.alive?'ok':'bad');
    el('plat').textContent=d.focus?('平台 '+d.focus.platform):'';
    el('upd').textContent='更新 '+new Date(d.now).toLocaleTimeString('zh-CN',{hour12:false});
    el('fresh').textContent='数据：心情 '+ago(freshOf(d.files,'mood.json'))+' · 德行 '+ago(freshOf(d.files,'virtue.json'))+' · 行为 '+ago(freshOf(d.files,'mbti-behavior.jsonl'));
    renderMBTI(d.mbti); renderMood(d.mood, d.files); renderVirtue(d.virtue, d.files, d.reasoning, d.tarot); renderTarot(d.tarot); renderLearn(d.lessons); renderChat(d.chat);
    renderMotives(d.motives, d.motiveMeta, d.files); renderFocus(d.focus); renderIntents(d.intents);
    renderReasoning(d.reasoning); renderNotebook(d.notebook); renderRelations(d.relationships);
    el('logs').textContent=(d.logs||[]).join('\n');
    breathCards(d);
  }catch(e){ el('br').textContent='连不上面板服务'; el('br').className='pill bad'; }
}
seedBreath();
if(String(location.search||'').includes('measure=1')){
  setTimeout(()=>{
    const r=(sel)=>{ const e=document.querySelector(sel); if(!e) return sel+':none';
      const b=e.getBoundingClientRect(); return sel+' x='+Math.round(b.left)+' w='+Math.round(b.width)+' y='+Math.round(b.top)+' h='+Math.round(b.height); };
    const out=[r('#mbtiBig'),r('.radar-wrap'),r('#radar'),r('.mbti-under'),r('.fish-side'),r('#fishAvatar'),r('#fishName'),r('#nums'),r('#mbtiSub')];
    document.title=out.join(' | ');
  }, 1200);
}
// 预览用：/?clearanim=1 只演一遍消失动画，不动任何数据
if(String(location.search||'').includes('clearanim=1')){
  setTimeout(()=>{ CHAT_CLEARING = true; animateBubblesOut(); }, 600);
}
tick(); setInterval(tick,3000);
</script></body></html>`;

export async function handlePanelRequest(req, res, { prefix = '/panel', brain = null } = {}) {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    let sub = url.pathname;
    if (prefix && (sub === prefix || sub.startsWith(prefix + '/'))) {
      sub = sub.slice(prefix.length) || '/';
    } else if (prefix && sub.startsWith(prefix)) {
      sub = sub.slice(prefix.length) || '/';
    }
    if (!sub || sub === '') {
      res.writeHead(302, { Location: (prefix || '') + '/' });
      res.end();
      return;
    }

    if (sub === '/api/snapshot') {
      let body = '{}';
      try { body = JSON.stringify(snapshot()); } catch (e) { body = JSON.stringify({ error: String(e?.message || e) }); }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
      return;
    }
    if (sub === '/api/reset' && req.method === 'POST') {
      let out = { ok: false, error: 'unknown' };
      try { out = doReset(url.searchParams.get('target')); } catch (e) { out = { ok: false, error: String(e?.message || e) }; }
      res.writeHead(out.ok ? 200 : 400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(out));
      return;
    }
    if (sub === '/api/undo' && req.method === 'POST') {
      let out = { ok: false, error: 'unknown' };
      try { out = doUndo(url.searchParams.get('target')); } catch (e) { out = { ok: false, error: String(e?.message || e) }; }
      res.writeHead(out.ok ? 200 : 400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(out));
      return;
    }
    if (sub === '/api/tarot/reroll' && req.method === 'POST') {
      let out = { ok: false, error: 'unknown' };
      try {
        const rec = tarotReroll((m) => { try { fs.appendFileSync(PANEL_LOG, new Date().toISOString() + ' ' + m + '\n'); } catch {} });
        out = rec && rec.disabled ? { ok: false, error: '牌灵开关是关着的，先打开' } : { ok: true, name: rec?.name, orientation: rec?.orientation, title: rec?.title };
      } catch (e) { out = { ok: false, error: String(e?.message || e) }; }
      res.writeHead(out.ok ? 200 : 400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(out));
      return;
    }
    if (sub === '/api/set' && req.method === 'POST') {
      let out = { ok: false, error: 'unknown' };
      try { out = doSet(url.searchParams.get('kind'), url.searchParams); } catch (e) { out = { ok: false, error: String(e?.message || e) }; }
      res.writeHead(out.ok ? 200 : 400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(out));
      return;
    }
    if (sub === '/api/tarot' && req.method === 'POST') {
      let out = { ok: false, error: 'unknown' };
      try { out = setTarotEnabled(url.searchParams.get('enabled') === '1'); } catch (e) { out = { ok: false, error: String(e?.message || e) }; }
      res.writeHead(out.ok ? 200 : 400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(out));
      return;
    }
    if (sub === '/api/chat/clear' && req.method === 'POST') {
      let out = { ok: false, error: 'unknown' };
      try { out = doClearChat(); } catch (e) { out = { ok: false, error: String(e?.message || e) }; }
      res.writeHead(out.ok ? 200 : 400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(out));
      return;
    }
    if (sub === '/api/chat/send' && req.method === 'POST') {
      const text = url.searchParams.get('text') || '';
      if (!text) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'empty text' }));
        return;
      }
      const now = Date.now();
      const chatFile = path.join(STATE, 'chat-tail.jsonl');
      const turnsFile = path.join(STATE, 'turns.jsonl');
      
      const inRec = { dir: 'in', text, at: now };
      try { fs.appendFileSync(chatFile, JSON.stringify(inRec) + '\n', 'utf8'); } catch {}

      let reply = '';
      if (brain && typeof brain.reply === 'function') {
        try {
          const r = await brain.reply({
            key: 'private:578021239',
            userId: '578021239',
            userName: '老爸',
            text,
            situation: '老爸通过心智控制面板给你发来了消息。',
          });
          reply = r?.text || '';
        } catch (e) {
          reply = '（小鱼大脑正在思考中...）收到啦老爸！';
        }
      } else {
        reply = '收到啦老爸！本鱼正在电脑前盯着面板呢~';
      }

      const outRec = { dir: 'out', text: reply, at: Date.now() };
      try {
        fs.appendFileSync(chatFile, JSON.stringify(outRec) + '\n', 'utf8');
        const turnRec = { t: now, where: 'private:578021239', who: 'Mew', text, reply };
        fs.appendFileSync(turnsFile, JSON.stringify(turnRec) + '\n', 'utf8');
      } catch {}

      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, reply }));
      return;
    }
    if (sub === '/api/respect/unblock' && req.method === 'POST') {
      const uid = url.searchParams.get('uid');
      if (!uid) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'missing uid' }));
        return;
      }
      try {
        const respectFile = path.join(STATE, 'respect.json');
        const raw = JSON.parse(fs.readFileSync(respectFile, 'utf8') || '{}');
        if (raw.users && raw.users[uid]) {
          raw.users[uid].strikes = 0;
          raw.users[uid].disliked = false;
          raw.users[uid].level = '已解除';
          raw.users[uid].lastAt = Date.now();
          fs.writeFileSync(respectFile, JSON.stringify(raw, null, 2), 'utf8');
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ ok: true, name: raw.users[uid].name }));
          return;
        }
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
        return;
      }
    }
    if (sub === '/api/notebook') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ dir: NOTEBOOK, files: notebookList() }));
      return;
    }
    if (sub === '/api/note') {
      const got = noteRead(url.searchParams.get('p'));
      res.writeHead(got.error ? 400 : 200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(got));
      return;
    }
    if (sub.startsWith('/mbti/')) {
      const name = sub.slice('/mbti/'.length);
      if (!/^[EI][NS][TF][JP]\.png$/.test(name)) { res.writeHead(400); res.end('bad name'); return; }
      fs.readFile(path.join(ASSETS, 'mbti-' + name), (e, buf) => {
        if (e) { res.writeHead(404); res.end('no avatar'); return; }
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=600' });
        res.end(buf);
      });
      return;
    }
    if (sub.startsWith('/tarot/')) {
      const name = sub.slice('/tarot/'.length);
      if (!/^\d{2}\.jpg$/.test(name)) { res.writeHead(400); res.end('bad name'); return; }
      fs.readFile(path.join(ASSETS, 'tarot-' + name), (e, buf) => {
        if (e) { res.writeHead(404); res.end('no card'); return; }
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=600' });
        res.end(buf);
      });
      return;
    }
    if (sub.startsWith('/fish/')) {
      const name = sub.slice('/fish/'.length);
      if (!/^[A-Z]{4}\.png$/.test(name)) { res.writeHead(400); res.end('bad name'); return; }
      fs.readFile(path.join(ASSETS, 'fish-' + name), (e, buf) => {
        if (e) { res.writeHead(404); res.end('no fish'); return; }
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=300' });
        res.end(buf);
      });
      return;
    }
    if (sub === '/' || sub === '/index.html') {
      let html = PAGE;
      if (prefix) {
        html = html
          .replaceAll("'/api/", `'${prefix}/api/`)
          .replaceAll('"/api/', `"${prefix}/api/`)
          .replaceAll("'/tarot/", `'${prefix}/tarot/`)
          .replaceAll('"/tarot/', `"${prefix}/tarot/`)
          .replaceAll("'/mbti/", `'${prefix}/mbti/`)
          .replaceAll('"/mbti/', `"${prefix}/mbti/`)
          .replaceAll("'/fish/", `'${prefix}/fish/`)
          .replaceAll('"/fish/', `"${prefix}/fish/`)
          .replaceAll('src="/tarot/', `src="${prefix}/tarot/`)
          .replaceAll('src="/mbti/', `src="${prefix}/mbti/`)
          .replaceAll('src="/fish/', `src="${prefix}/fish/`);
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('只有 / 和 /api/snapshot');
  } catch (e) {
    try { res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); res.end('面板内部错误：' + (e?.message || e)); } catch {}
    try { fs.appendFileSync(PANEL_LOG, new Date().toISOString() + ' 请求出错 ' + req.url + ' :: ' + (e?.stack || e) + '\n'); } catch {}
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const server = http.createServer((req, res) => {
    handlePanelRequest(req, res, { prefix: '' });
  });
  server.listen(PORT, '0.0.0.0', () => {
    console.log('[panel] http://0.0.0.0:' + PORT + ' (owner=' + (OWNER || '?') + ')');
  });
}

// 2026-11-04：面板之前会毫无声息地死掉（一个请求抛异常就整个进程没了，且没有任何日志）。
// 现在兜住：记日志、继续跑，别再让「打不开」变成无从查起的事。
function panelLog(line) {
  try { fs.appendFileSync(PANEL_LOG, new Date().toISOString() + ' ' + line + '\n'); } catch {}
}
process.on('uncaughtException', (e) => { panelLog('未捕获异常 :: ' + (e?.stack || e)); });
process.on('unhandledRejection', (e) => { panelLog('未处理的 Promise 拒绝 :: ' + (e?.stack || e)); });
process.on('SIGTERM', () => { panelLog('收到 SIGTERM，退出'); process.exit(0); });
panelLog('面板启动 PID ' + process.pid + ' 端口 ' + PORT);






