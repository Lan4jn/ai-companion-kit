import { splitBurstPreserving } from './burst-split.js';

/**
 * 拟人化发送 · 让它打字不像机器
 * ─────────────────────────────────────────────────────────────
 * 一个真人发消息是这样的：
 *   1. 先"正在输入…"一会儿（时间跟字数成正比，但不完全成正比）
 *   2. 短句分几条发，不是一大段
 *   3. 条与条之间有停顿，偶尔停久一点（像在走神/被打断）
 *   4. 深夜和白天的节奏不一样
 *
 * 这个模块只做这件事。它不关心消息内容，只关心"怎么发出去"。
 */

/** 睡觉时段（本地时间），这段时间回复会明显变慢 */
const NIGHT = { from: 2, to: 7 };
/** 打字速度：每字毫秒。中文手打大概 80~140ms/字，这里给个偏快的值 */
const DEFAULT_MS_PER_CHAR = 85;

// Preserve protected tokens and split only at conservative grapheme boundaries.
// Limits are measured in Unicode code points, not UTF-16 code units.
const SEGMENT_LIMIT = 1000;
export const CHAT_CAPACITY_NOTICE = '这部分我暂时没法完整说清楚，你想先了解哪一点？';
export function prepareChatParts(text, human = new Humanizer()) {
  try {
    let parts = Array.isArray(text) ? text.flatMap(s => human.split(String(s), 3)) : human.split(text, 3);
    // Preferred punctuation breaks can create an unnecessary fourth message.
    if (parts.length > 3 && (!Array.isArray(text) || text.length === 1)) parts = splitLongReply(String(Array.isArray(text) ? text[0] : text), false);
    if (parts.length > 3 || parts.some(p => [...p].length > SEGMENT_LIMIT)) throw new RangeError('capacity exceeded');
    return {parts, capacityExceeded: false};
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return {parts: [CHAT_CAPACITY_NOTICE], capacityExceeded: true, error: error.message};
  }
}
function splitLongReply(text, preferBreaks = true) {
  const limit = SEGMENT_LIMIT;
  const protectedRanges = [];
  const tokens = /(`{3,}|~{3,})[^\r\n]*(?:[\s\S]*?\1|[\s\S]*$)|\[CQ:[^\]]*\]|!?\[[^\]\n]*\]\([^\s)]*(?:\([^\s()]*\)[^\s)]*)*\)|https?:\/\/[^\s<>]+|www\.[^\s<>]+|`[^`\r\n]+`/gi;
  for (const match of text.matchAll(tokens)) protectedRanges.push([match.index, match.index + match[0].length]);
  // Avoid Intl.Segmenter here: the deployed Node/ICU build can segfault.
  // Keep combining marks, variation selectors, emoji modifiers, ZWJ chains,
  // CRLF and regional-indicator flag pairs together.
  const boundaries = [0];
  const cps = [...text];
  let offset = 0, regionalRun = 0, previous = '';
  for (const cp of cps) {
    const regional = /\p{Regional_Indicator}/u.test(cp);
    const hangulType = (c) => {
      const n = c.codePointAt(0);
      if ((n >= 0x1100 && n <= 0x115f) || (n >= 0xa960 && n <= 0xa97c)) return 'L';
      if ((n >= 0x1160 && n <= 0x11a7) || (n >= 0xd7b0 && n <= 0xd7c6)) return 'V';
      if ((n >= 0x11a8 && n <= 0x11ff) || (n >= 0xd7cb && n <= 0xd7fb)) return 'T';
      if (n >= 0xac00 && n <= 0xd7a3) return (n - 0xac00) % 28 ? 'LVT' : 'LV';
      return '';
    };
    const a = previous && hangulType(previous), b = hangulType(cp);
    const hangul = (a === 'L' && ['L', 'V', 'LV', 'LVT'].includes(b)) || (['LV', 'V'].includes(a) && ['V', 'T'].includes(b)) || (['LVT', 'T'].includes(a) && b === 'T');
    const joins = offset > 0 && (hangul || /\p{Mark}|\p{Emoji_Modifier}|[\uFE00-\uFE0F\u{E0100}-\u{E01EF}\u{E0020}-\u{E007F}\u200D]/u.test(cp)
      || (/\p{Mark}/u.test(previous) && /[^\x00-\x7f]/u.test(cp))
      || previous === '\u200d' || (previous === '\r' && cp === '\n') || (regional && regionalRun % 2 === 1));
    if (!joins && offset > 0) boundaries.push(offset);
    offset += cp.length;
    regionalRun = regional ? regionalRun + 1 : 0;
    previous = cp;
  }
  boundaries.push(offset);
  const parts = [];
  let start = 0, pos = 0, range = 0;
  while (start < text.length) {
    let last = start, preferred = start, count = 0;
    while (pos + 1 < boundaries.length && count < limit) {
      const next = boundaries[pos + 1];
      const width = [...text.slice(boundaries[pos], next)].length;
      if (count + width > limit) break;
      pos++;
      while (range < protectedRanges.length && protectedRanges[range][1] <= next) range++;
      const inside = range < protectedRanges.length && protectedRanges[range][0] < next && next < protectedRanges[range][1];
      count += width;
      if (!inside) {
        last = next;
        if (count >= limit / 2 && /[\n。！？；，!?;\s]/u.test(text.slice(boundaries[pos - 1], next))) preferred = next;
      }
    }
    if (last === start) {
      throw new RangeError(`存在超过 ${limit} 个字符的不可分割内容（链接、CQ、代码或字素），无法安全发送`);
    }
    const end = preferBreaks && preferred > start ? preferred : last;
    parts.push(text.slice(start, end));
    start = end;
    while (boundaries[pos] > start) pos--;
    while (range > 0 && protectedRanges[range - 1][1] > start) range--;
  }
  return parts;
}

export class Humanizer {
  /**
   * @param {object} opts
   * @param {boolean} [opts.enabled=true]      总开关
   * @param {number}  [opts.msPerChar=85]      每字打字时间
   * @param {number}  [opts.minMs=1200]        最短"正在输入"时长
   * @param {number}  [opts.maxMs=6000]        最长"正在输入"时长
   * @param {number}  [opts.jitter=0.2]        抖动比例（±20%）
   * @param {number}  [opts.burstMax=4]        一次最多分几条发
   * @param {[number,number]} [opts.gapRange]  条间停顿范围（毫秒）
   * @param {number}  [opts.longGapChance=0.25] 出现"长停顿"的概率
   * @param {[number,number]} [opts.longGapRange] 长停顿范围
   */
  constructor(opts = {}) {
    this.enabled = opts.enabled !== false;
    this.msPerChar = opts.msPerChar ?? DEFAULT_MS_PER_CHAR;
    this.minMs = opts.minMs ?? 1200;
    this.maxMs = opts.maxMs ?? 6000;
    this.jitter = opts.jitter ?? 0.2;
    this.burstMax = opts.burstMax ?? 3;
    this.gapRange = opts.gapRange ?? [700, 2600];
    this.longGapChance = opts.longGapChance ?? 0.25;
    this.longGapRange = opts.longGapRange ?? [3000, 9000];
    // 默认保留正文；显式配置 typoRate 才启用模拟错字。
    this.typoRate = opts.typoRate ?? 0;
    // 默认保留原文标点；仅在明确启用时做聊天风格处理。
    this.stripPeriod = opts.stripPeriod === true;
  }

  /**
   * 去掉句尾句号。
   * 中文聊天里句子结尾那个「。」几乎只有 AI 和公文会打，真人要么不打，
   * 要么用空格、「…」或者干脆断成两条。
   */
  stripTail(text) {
    let t = String(text || '');
    if (!this.stripPeriod || !t) return t;
    // 别动 CQ 码结尾的段落（发表情包不该被改）
    if (/\[CQ:[^\]]*\]$/.test(t)) return t;
    // 只干掉结尾的句号，问号叹号省略号都保留
    t = t.replace(/[。\.]+\s*$/, '');
    return t.trim();
  }

  /**
   * 刻意留语病。
   *
   * 量化标准：真人手打大概每千字 1.6 个语病。一条 15 字的消息只有 2~3% 的概率带一个，
   * 一年下来也碰不到几次，但一旦出现，"真人感"会明显上一个台阶。
   *
   * 三条硬规则：
   *   - 代码、数字、路径、链接、CQ 码、@ 一个字都不碰
   *   - 太短的分句不加（"嗯"、"行"这种加了就是纯错字）
   *   - 只做漏字/同音字/重字三种，不做语序颠倒（那会真的看不懂）
   */
  typoize(text) {
    const t = String(text || '');
    if (!this.typoRate || t.length < 8) return t;
    if (/[\[\]{}<>]|https?:\/\/|\[CQ:|\d{3,}/.test(t)) return t;   // 有技术内容就不碰

    const chn = [...t].filter((c) => /[\u4e00-\u9fa5]/.test(c)).length;
    if (chn < 8) return t;
    if (Math.random() > chn * this.typoRate) return t;

    const HOMO = [['在', '再'], ['再', '在'], ['那', '哪'], ['做', '作'], ['得', '的'], ['吧', '把']];
    const FILLER = ['的', '了', '就', '是', '也', '都'];
    const chars = [...t];

    const kind = Math.random();
    // a) 漏字：删一个虚词，最像手滑
    if (kind < 0.5) {
      const idxs = [];
      chars.forEach((c, i) => { if (FILLER.includes(c) && i > 0 && i < chars.length - 1) idxs.push(i); });
      if (!idxs.length) return t;
      const i = idxs[Math.floor(Math.random() * idxs.length)];
      chars.splice(i, 1);
      return chars.join('');
    }
    // b) 同音字：只换第一个能换的
    if (kind < 0.85) {
      for (let i = 0; i < chars.length; i++) {
        const hit = HOMO.find(([a]) => a === chars[i]);
        if (hit && Math.random() < 0.5) {
          chars[i] = hit[1];
          return chars.join('');
        }
      }
      return t;
    }
    // c) 重字：把某一个字重复一次（"就" → "就就"）
    const cands = [];
    chars.forEach((c, i) => { if (/[\u4e00-\u9fa5]/.test(c) && i > 0) cands.push(i); });
    if (!cands.length) return t;
    const i = cands[Math.floor(Math.random() * cands.length)];
    return chars.slice(0, i + 1).join('') + chars[i] + chars.slice(i + 1).join('');
  }

  /** 按字数算"正在输入"该持续多久 (过滤掉 base64 图片等 CQ 码长度) */
  typingMsFor(text) {
    if (typeof text === 'string' && text.includes('[CQ:image')) {
      return 600; // 图片无需长打字时间
    }
    const clean = String(text || '').replace(/\[CQ:[^\]]+\]/g, '');
    const n = [...clean].length;
    let ms = this.minMs + n * this.msPerChar;
    ms = Math.min(this.maxMs, Math.max(this.minMs, ms));
    // 抖动
    ms *= 1 + (Math.random() * 2 - 1) * this.jitter;
    // 深夜慢一点（半睡半醒）
    const h = new Date().getHours();
    if (h >= NIGHT.from && h < NIGHT.to) ms *= 1.6;
    return Math.round(ms);
  }

  /** 条与条之间停多久 */
  gapMs() {
    const [a, b] = this.gapRange;
    let ms = a + Math.random() * Math.max(0, b - a);
    if (Math.random() < this.longGapChance) {
      const [c, d] = this.longGapRange;
      ms += c + Math.random() * Math.max(0, d - c);
    }
    return Math.round(ms);
  }

  /**
   * 把一段长回复切成"像人打出来的"若干条
   * - 保护 [CQ:image,...] 码不被切散
   * - 短消息和已有换行保持原有行为；长单行优先在句末分条
   * - 很长的单句可在中文逗号或分号处分条；代码、CQ 码和链接保守处理
   * - 单次发送最多 burstMax 条；长单行按句子尽量均衡分配，绝不物理截断
   * - 默认保留句尾标点；显式启用 stripPeriod 时才做清理
   */
  split(text, max = this.burstMax) {
    const source = String(text ?? '');
    if (!source) return [];
    if ([...source].length > SEGMENT_LIMIT) return splitLongReply(source);
    if (/\n\s*\n/.test(source) && !/[`\\]|\[CQ:|https?:\/\/|www\.|^\s*(?:[-*+] |\d+[.)] |>|#{1,6} )/im.test(source)) {
      const chunks = source.match(/[\s\S]*?(?:\r?\n[ \t]*\r?\n|$)/g)?.filter(Boolean) || [source];
      if (chunks.every(x => x.trim())) {
        const count = Math.min(Math.max(1, Math.floor(max) || 1), 3);
        return chunks.length <= count ? chunks : [...chunks.slice(0, count - 1), chunks.slice(count - 1).join('')];
      }
    }
    // Keep legacy sentence bubbles only when the output reconstructs the input.
    // Technical material and line breaks remain in a single unmodified message.
    if (/[\r\n\u2028\\`]|https?:\/\/|www\.|__CQ_/i.test(source)) return [source];
    const count = Math.min(this.burstMax, max, 3);
    const parts = splitBurstPreserving(source, { maxParts: count });
    if (parts.length > 1 || /\[CQ:/i.test(source)) return parts;
    const legacy = this._splitLegacy(source, count);
    return legacy.join('') === source ? legacy : [source];
  }

  _splitLegacy(text, max) {
    const source = String(text ?? '');
    // Long replies must bypass the legacy newline normalization and burst limit:
    // those transform content or can leave an arbitrarily large final message.
    if ([...source].length > 1000) return splitLongReply(source);
    const raw = source.trim();
    if (!raw) return [];

    // 代码块的换行和转义均属于正文，不能作消息分隔或规范化。
    if (raw.includes('```')) return [raw];

    // 兼容模型输出的字面量反斜杠换行 \n 与真实换行
    const normalized = raw.replace(/\\{1,3}n/g, '\n').replace(/\r\n?/g, '\n').replace(/\u2028/g, '\n');

    // 抽取出 CQ 码，防止被分句切割。
    // at 必须留在原句里（@ 和前后文字同一条气泡），image 单独成条更自然。
    const cqImages = [];
    const sanitized = normalized.replace(/\[CQ:(at|image),[^\]]+\]/g, (match, kind) => {
      const token = `__CQ_${kind.toUpperCase()}_${cqImages.length}__`;
      cqImages.push(match);
      return kind === 'image' ? `\n${token}\n` : token;
    });

    // 只按换行分条，不转换行内空格，避免损坏原文。
    const lines = sanitized.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    // 单行优先在完整句末分段；过长的单句才尝试中文逗号或分号。
    // 技术内容整体保留，避免切开链接、代码、CQ 码或 Markdown。
    if (lines.length === 1 && Math.max(1, Math.floor(max) || 1) > 1
        && [...lines[0]].length > 60
        && !/`|\[CQ:|__CQ_(?:IMAGE|AT)_|https?:\/\/|www\./i.test(lines[0])) {
      let sentences = lines[0].match(/.*?[。！？!?]+[”’」』）)]*(?:\s*|$)|.+$/gu) || [lines[0]];
      if (sentences.length === 1 && [...lines[0]].length > 120) {
        sentences = lines[0].match(/.*?[，；]+[”’」』）)]*\s*|.+$/gu) || [lines[0]];
      }
      if (sentences.length > 1) {
        const limit = Math.max(1, Math.floor(max) || 1);
        const parts = [];
        let rest = sentences.join('');
        let current = '';
        for (let i = 0; i < sentences.length; i++) {
          const sentence = sentences[i];
          current += sentence;
          rest = rest.slice(sentence.length);
          const slots = limit - parts.length;
          const target = ([...current].length + [...rest].length) / slots;
          const currentLength = [...current].length;
          const nextLength = [...(sentences[i + 1] || '')].length;
          if (slots > 1 && rest && (currentLength >= target || i === sentences.length - 2
              || Math.abs(target - currentLength) <= Math.abs(target - currentLength - nextLength))) {
            parts.push(current);
            current = '';
          }
        }
        if (current) parts.push(current);
        if (parts.length > 1) return parts;
      }
    }
    const out = lines;

    // 2) 合并极短无意义碎片（例如单独残留的标点或 < 3 字的碎片，与相邻句子合并）
    const merged = [];
    for (const s of out) {
      const last = merged[merged.length - 1];
      if (s.startsWith('__CQ_IMAGE_') || last?.startsWith('__CQ_IMAGE_')) {
        merged.push(s);
      } else {
        const lastLen = last ? [...last.replace(/\u200B/g, '').replace(/\s+/g, '')].length : 0;
        const sLen = [...s.replace(/\u200B/g, '').replace(/\s+/g, '')].length;
        if (last && lastLen < 3 && (lastLen + sLen <= 32)) {
          merged[merged.length - 1] = last + ' ' + s;
        } else {
          merged.push(s);
        }
      }
    }

    // 3) 合并超量部分，保持文字和图片的原始顺序。
    const limit = Math.max(1, Math.floor(max) || 1);
    const res = merged.length > limit
      ? [...merged.slice(0, limit - 1), merged.slice(limit - 1).join('\n')]
      : merged;

    // 4) 还原 CQ 码，只规范整段回复的末尾句号。
    return res.map((part, i) => {
      const back = part.replace(/__CQ_(?:IMAGE|AT)_(\d+)__/g, (_, idx) => cqImages[Number(idx)] || '');
      return i === res.length - 1 ? this.stripTail(back) : back;
    }).filter(Boolean);
  }

  /**
   * 执行一次拟人化发送
   *
   * @param {string|string[]} text        要说的话（字符串会被自动切分）
   * @param {object} io
   * @param {(on:boolean)=>Promise<void>} [io.setTyping]  切换"正在输入"状态
   * @param {(msg:string)=>Promise<any>}  io.send          真正发一条
   * @param {(ms:number)=>Promise<void>}  [io.sleep]       等待（默认 setTimeout，测试时可注入）
   * @returns {Promise<{sent:number, parts:string[]}>}\n   */
  async say(text, { setTyping, send, sleep, prepared = false } = {}) {
    const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    if (prepared && (!Array.isArray(text) || text.length > 3 || text.some(p => typeof p !== 'string' || !p || [...p].length > SEGMENT_LIMIT))) throw new RangeError('invalid prepared messages');
    if (!prepared && Array.isArray(text) && text.some(p => typeof p !== 'string' || [...p].length > SEGMENT_LIMIT)) return {sent: 0, parts: [], ok: false, error: '消息过长，无法安全发送'};
    const {parts, capacityExceeded, error} = prepared ? {parts: text} : prepareChatParts(text, this);
    if (capacityExceeded && error && error !== 'capacity exceeded') return {sent: 0, parts: [], ok: false, error};
    if (!parts.length) return { sent: 0, parts: [] };

    let sent = 0;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (this.enabled) {
        if (setTyping) { try { await setTyping(true); } catch { /* 有些平台不支持，忽略 */ } }
        await wait(this.typingMsFor(p));
        if (setTyping) { try { await setTyping(false); } catch {} }
      }
      const result = await send(p);
      if (result?.ok === false || result?.blocked === true || (result?.outcome != null && result.outcome !== 'confirmed')) return { sent, parts, ok: false, error: result.error || result.reason || 'SEND_NOT_CONFIRMED' };
      sent++;
      if (this.enabled && i < parts.length - 1) await wait(this.gapMs());
    }
    return { sent, parts, ...(capacityExceeded ? {capacityExceeded: true} : {}) };
  }
}

export default Humanizer;
