// tarot-engine.js — 牌灵：每天 06:00 纯随机抽一张大阿卡纳定当日基调
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

const COOLDOWN_DAYS = 3;      // 近 3 天抽过的不进候选
const DAY_START_HOUR = 6;     // 每天 06:00 换牌

let _cards = null;
function getCards(dataDir) {
  if (!_cards) {
    const candidates = [
      path.join(dataDir || path.join(ROOT, 'data'), 'tarot-cards.json'),
      path.join(ROOT, 'data', 'tarot-cards.json'),
      path.join(HERE, 'tarot-cards.json')
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        try {
          _cards = JSON.parse(fs.readFileSync(p, 'utf8')).cards;
          break;
        } catch (e) {}
      }
    }
  }
  return _cards || [];
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function readTarot(dataDir) {
  const dir = dataDir || path.join(ROOT, 'data');
  const file = path.join(dir, 'tarot.json');
  return readJson(file, null) || { date: '', history: [] };
}

function writeTarot(state, dataDir) {
  try {
    const dir = dataDir || path.join(ROOT, 'data');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'tarot.json'), JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    /* 写不进去也不能让服务挂 */
  }
}

/** 日界：以 06:00 为界（凌晨 5 点还算昨天的牌） */
export function dayKey(now = Date.now()) {
  const d = new Date(now - DAY_START_HOUR * 3600e3);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 抽一张：22 张等概率 × 正逆位五五开。
 * cooldown=true（每天 6 点那次）：近 3 天出现过的「同一张牌 + 同一个正逆位」不进池
 */
export function pickCard({ dataDir, history = [], now = Date.now(), rnd = Math.random, cooldown = true } = {}) {
  const all = getCards(dataDir);
  if (!all.length) return null;
  if (cooldown) {
    const cutoff = now - COOLDOWN_DAYS * 24 * 3600e3;
    const seen = new Set();
    for (const h of history || []) {
      if (Number(h.at || 0) < cutoff) continue;
      seen.add(String(h.name || '') + '|' + String(h.orientation || ''));
    }
    const fresh = [];
    for (const c of all) {
      if (!seen.has(c.name + '|正位')) fresh.push({ card: c, orientation: '正位' });
      if (!seen.has(c.name + '|逆位')) fresh.push({ card: c, orientation: '逆位' });
    }
    if (fresh.length) {
      const pick = fresh[Math.min(fresh.length - 1, Math.floor(rnd() * fresh.length))];
      return { card: pick.card, orientation: pick.orientation, poolSize: fresh.length };
    }
  }
  const card = all[Math.min(all.length - 1, Math.floor(rnd() * all.length))];
  const upright = rnd() >= 0.5;
  return { card, orientation: upright ? '正位' : '逆位', poolSize: all.length * 2 };
}

/**
 * 每天跑一次：纯随机抽一张，写 data/tarot.json。
 * 一天只算一次；重启后若当天没算过会补算。
 */
export function tarotDailyTick(dataDirOrLog, maybeLog, now = Date.now(), rnd = Math.random) {
  let dataDir = null;
  let log = console.log;
  if (typeof dataDirOrLog === 'string') {
    dataDir = dataDirOrLog;
    if (typeof maybeLog === 'function') log = maybeLog;
  } else if (typeof dataDirOrLog === 'function') {
    log = dataDirOrLog;
  }
  const key = dayKey(now);
  const st = readTarot(dataDir);
  if (st.enabled === false) return { skipped: true, disabled: true };
  if (st.date === key && st.name) return { skipped: true, ...st };

  const picked = pickCard({ dataDir, history: st.history || [], now, rnd });
  if (!picked) return { skipped: true, error: 'cards_empty' };
  const { card, orientation, poolSize } = picked;
  const side = orientation === '逆位' ? card.rev : card.pos;

  const record = {
    date: key,
    enabled: true,
    at: now,
    id: card.id,
    name: card.name,
    title: card.title,
    orientation,
    goodReversed: orientation === '逆位' && Boolean(card.rev?.good),
    today: side?.today || '',
    how: side?.how || [],
    still: side?.still || '',
    poolSize,
    history: [...(st.history || []), { at: now, date: key, name: card.name, orientation }].slice(-30),
  };
  writeTarot(record, dataDir);

  const prev = st.name && st.name !== card.name ? `｜翻自 ${st.name}` : '';
  log(`[牌灵] 今天：${card.name} ${orientation}（${card.title}）${prev}`);
  return record;
}

export function tarotReroll(dataDirOrLog, maybeLog, now = Date.now(), rnd = Math.random) {
  let dataDir = null;
  let log = console.log;
  if (typeof dataDirOrLog === 'string') {
    dataDir = dataDirOrLog;
    if (typeof maybeLog === 'function') log = maybeLog;
  } else if (typeof dataDirOrLog === 'function') {
    log = dataDirOrLog;
  }
  const st = readTarot(dataDir);
  if (st.enabled === false) return { disabled: true };
  const key = dayKey(now);
  const picked = pickCard({ dataDir, history: st.history || [], now, rnd, cooldown: false });
  if (!picked) return { error: 'cards_empty' };
  const { card, orientation, poolSize } = picked;
  const side = orientation === '逆位' ? card.rev : card.pos;
  const record = {
    date: key,
    enabled: true,
    at: now,
    id: card.id,
    name: card.name,
    title: card.title,
    orientation,
    goodReversed: orientation === '逆位' && Boolean(card.rev?.good),
    today: side?.today || '',
    how: side?.how || [],
    still: side?.still || '',
    poolSize,
    rerolled: true,
    history: [...(st.history || []), { at: now, date: key, name: card.name, orientation }].slice(-30),
  };
  writeTarot(record, dataDir);
  log(`[牌灵] 手动重抽：${card.name} ${orientation}（${card.title}）`);
  return record;
}

/** 给提示词用的一段：不超过 60 字，纯潜意识底色，绝不主动报菜名 */
export function tarotPromptBlock(dataDir, now = Date.now()) {
  const st = readTarot(dataDir);
  if (st?.enabled === false || !st?.name) return '';
  const all = getCards(dataDir);
  const card = all.find((c) => c.name === st.name);
  const side = st.orientation === '逆位' ? card?.rev : card?.pos;
  const inject = side?.inject || `今天你像${st.name}。`;
  return `【今日心境底色】${inject}（这是你的潜意识底色，自然融入谈吐，切勿主动念咒提“牌灵”或“运势”）。`;
}

export function tarotSummary(dataDir, now = Date.now()) {
  const st = readTarot(dataDir);
  if (!st?.name) return null;
  const all = getCards(dataDir);
  const card = all.find((c) => c.name === st.name);
  const side = st.orientation === '逆位' ? card?.rev : card?.pos;
  return {
    date: st.date,
    name: st.name,
    title: st.title,
    orientation: st.orientation,
    today: side?.today || '',
    how: side?.how || [],
    still: side?.still || '',
    fresh: st.date === dayKey(now),
  };
}
