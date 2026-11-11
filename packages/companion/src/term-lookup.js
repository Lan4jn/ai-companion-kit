/**
 * 未知黑话 / 缩写「先查后答」前置查证模块 (TermLookup)
 * ─────────────────────────────────────────────────────────────
 * 背景：群里有人甩出一句没见过的新缩写（例如「sm的m」），如果小鱼不认识还硬猜着解释，
 * 就会像在瞎编，真人会先愣一下或者查明白再接话。
 *
 * 机制：
 * 1. 从群友这句短消息里提取可疑的英文缩写 / 生僻词语候选；
 * 2. 先查本地梗词典（meme_dictionary.json）与自己潜水学到的黑话（human-insights.json）；
 * 3. 都不认识才联网快速查一次（SearXNG），结果缓存到 term-cache.json，14 天内不重复查；
 * 4. 把查到的结果作为「事实资料」注入给她，并明确要求：资料没说明白就别硬编，宁可反问一句。
 */

import fs from 'node:fs';
import path from 'node:path';
import { executeSearchTool } from './search-tools.js';

// 日常常见词，不当作未知黑话去查
const COMMON_EN = new Set([
  'ok', 'okay', 'yes', 'no', 'hi', 'hey', 'id', 'qq', 'pc', 'ai', 'cpu', 'gpu', 'ram', 'ssd', 'hdd',
  'usb', 'hdmi', 'dp', 'fps', 'hz', 'ms', 'mb', 'gb', 'tb', 'kb', 'k', 'w', 'kw',
  'lol', 'dota', 'cs', 'cs2', 'csgo', 'pubg', 'steam', 'epic', 'mod', 'dlc', 'bug',
  'log', 'api', 'url', 'http', 'https', 'ip', 'dns', 'vpn', 'nas', 'nas', 'os', 'ios', 'mac',
  'amd', 'nvd', 'rtx', 'gtx', 'mt', 'pro', 'max', 'plus', 'mini', 'ultra', 'se',
  'up', 'uv', 'tv', 'us', 'we', 'me', 'my', 'you', 'it', 'is', 'at', 'in', 'on', 'to',
]);

// 涉及成人/性内容的结果直接丢弃，不往群里带
const ADULT_PATTERNS = [
  /bdsm|sm\s*\(|性虐待|性快感|性变态|虐恋|调教|性行为|性学|成人影片|色情/i,
];

const CACHE_TTL_MS = 14 * 24 * 3600 * 1000;

function getCacheFile(dataDir) {
  return path.join(dataDir, 'term-cache.json');
}

function loadCache(dataDir) {
  try {
    const f = getCacheFile(dataDir);
    if (!fs.existsSync(f)) return {};
    return JSON.parse(fs.readFileSync(f, 'utf8')) || {};
  } catch {
    return {};
  }
}

function saveCache(dataDir, cache) {
  try {
    // 只保留最近 200 条，防止文件无限膨胀
    const keys = Object.keys(cache);
    if (keys.length > 200) {
      const sorted = keys.sort((a, b) => (cache[b].at || 0) - (cache[a].at || 0)).slice(0, 200);
      const trimmed = {};
      for (const k of sorted) trimmed[k] = cache[k];
      cache = trimmed;
    }
    fs.writeFileSync(getCacheFile(dataDir), JSON.stringify(cache, null, 2), 'utf8');
  } catch {}
}

/** 读取本地已知词汇（梗词典 + 潜水学到的黑话） */
function loadKnownVocabulary(dataDir) {
  const known = new Set();
  try {
    const dictFile = path.join(dataDir, 'meme_dictionary.json');
    if (fs.existsSync(dictFile)) {
      const dict = JSON.parse(fs.readFileSync(dictFile, 'utf8'));
      for (const e of dict?.entries || []) {
        if (e.term) known.add(String(e.term).toLowerCase());
        for (const a of e.aliases || []) known.add(String(a).toLowerCase());
      }
    }
  } catch {}
  try {
    const insFile = path.join(dataDir, 'human-insights.json');
    if (fs.existsSync(insFile)) {
      const ins = JSON.parse(fs.readFileSync(insFile, 'utf8'));
      for (const s of ins?.slangs || []) {
        if (s.term) known.add(String(s.term).toLowerCase());
      }
    }
  } catch {}
  return known;
}

/**
 * 从一句话里提取可疑的未知缩写/黑话候选
 * 只处理短句（群友随手甩的缩写），长句不折腾
 */
export function extractCandidateTerms(text) {
  const s = String(text || '')
    .replace(/【引用\s+[^】]+】/gs, '')
    .replace(/\[CQ:[^\]]+\]/g, '')
    .trim();
  if (!s || s.length > 40) return [];

  const out = [];
  const push = (t) => {
    const clean = String(t || '').trim().toLowerCase();
    if (!clean) return;
    if (clean.length < 1 || clean.length > 8) return;
    if (/^[\d\W_]+$/.test(clean)) return;
    if (clean.length === 1 && !/[a-z]/i.test(clean)) return;
    if (COMMON_EN.has(clean)) return;
    if (!out.includes(clean)) out.push(clean);
  };

  // 1. 英文缩写（包含「X的Y」这种夹着英文的中文句式）
  const enTokens = s.match(/[A-Za-z][A-Za-z0-9]{0,7}/g) || [];
  for (const t of enTokens) {
    // 首字母大写的常见英文单词不当缩写
    if (/^[A-Z][a-z]{2,}$/.test(t)) continue;
    // 单个字母单独出现不当缩写（噪音太大），只有夹在「X的Y」里才有意义
    if (t.length === 1) continue;
    push(t);
  }

  // 2. 引号/括号里被特意点出来的词（只留纯字母/数字的缩写，带中文的是整句话）
  const quoted = s.match(/[「『"“]([^」』"”]{1,8})[」』"”]/g) || [];
  for (const q of quoted) {
    const inner = q.replace(/[「『"“」』"”]/g, '');
    if (/^[A-Za-z0-9\s.'-]+$/.test(inner)) push(inner);
  }

  // 3. 「X的Y」这种结构整体也算候选（首字母缩写常见玩法，如 sm的m）
  if (/的/.test(s) && /[A-Za-z]/.test(s) && s.length <= 12 && !/[\u4e00-\u9fa5]/.test(s.replace(/的/g, ''))) push(s);

  return out.slice(0, 3);
}

/** 单次联网查词，返回一句话解释或 null */
async function lookupTermOnline(term) {
  try {
    const r = await executeSearchTool('web_search', { query: `${term} 是什么意思 梗` });
    if (!r?.success || !r.text) return null;

    // 按条目拆开，只保留标题里确实提到这个词的结果，避免搜到什么算什么
    const termLower = term.toLowerCase();
    const blocks = String(r.text).split(/\n\s*\n/);
    const picked = [];
    for (const b of blocks) {
      const lines = b.split('\n').map((l) => l.trim()).filter(Boolean);
      if (!lines.length) continue;
      const head = lines[0];
      if (!head.includes('【')) continue;
      if (!head.toLowerCase().includes(termLower)) continue;
      const body = lines.slice(1).filter((l) => !/^\(来源/.test(l)).join(' ');
      if (!body) continue;
      if (ADULT_PATTERNS.some((p) => p.test(body) || p.test(head))) continue;
      picked.push({ head, body });
    }
    if (!picked.length) return null;

    const first = picked[0];
    const title = first.head.replace(/^\d+\.\s*【/, '').replace(/】$/, '');
    return `${title}：${first.body}`.slice(0, 160);
  } catch {
    return null;
  }
}

/**
 * 给一轮对话做「先查后答」的前置查证
 * @returns {Promise<string>} 可直接拼进 situation 的提示片段（无需查证时返回空串）
 */
export async function buildTermHint(rawText, { dataDir = './data' } = {}) {
  const candidates = extractCandidateTerms(rawText);
  if (!candidates.length) return '';

  const known = loadKnownVocabulary(dataDir);
  const cache = loadCache(dataDir);

  const unknown = candidates.filter((t) => !known.has(t));
  if (!unknown.length) return '';

  const lines = [];
  let changed = false;

  for (const term of unknown) {
    const hit = cache[term];
    if (hit && Date.now() - (hit.at || 0) < CACHE_TTL_MS) {
      lines.push(hit.found ? `- 「${term}」：${hit.meaning}` : `- 「${term}」：网上也没有明确说法`);
      continue;
    }

    const meaning = await lookupTermOnline(term);
    cache[term] = { found: Boolean(meaning), meaning: meaning || '', at: Date.now() };
    changed = true;
    lines.push(meaning ? `- 「${term}」：${meaning}` : `- 「${term}」：网上也没有明确说法`);
  }

  if (changed) saveCache(dataDir, cache);
  if (!lines.length) return '';

  return (
    '\n【先查后答·你不认识的新词（重要）】：刚刚对方话里出现了你不熟悉的说法，你临时查了一下：\n' +
    lines.join('\n') +
    '\n→ 铁律：资料里说得明白就直接理解着接话，但绝对不许编造解释、不许装作很懂；' +
    '如果资料没说明白或者查不到，就用真人的方式随口反问一句（如“这缩写啥意思”、“没看懂 说人话”），绝不硬猜硬圆。'
  );
}

export default { buildTermHint, extractCandidateTerms };
