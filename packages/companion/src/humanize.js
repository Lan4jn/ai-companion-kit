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
    this.burstMax = opts.burstMax ?? 4;
    this.gapRange = opts.gapRange ?? [700, 2600];
    this.longGapChance = opts.longGapChance ?? 0.25;
    this.longGapRange = opts.longGapRange ?? [3000, 9000];
    // 刻意留语病：真人手打每千字大概 1.6 个，设 0 可关掉
    this.typoRate = opts.typoRate ?? 0.0016;
    // 句尾句号是中文聊天里最重的 AI 指纹，默认去掉
    this.stripPeriod = opts.stripPeriod !== false;
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
   * - 已经在换行的地方切开
   * - 太长的一句按标点再切
   * - 保护英文单词、数字和中英文之间的空格不被误切
   * - 切完不超过 burstMax 条（多余的合并回最后一条）
   */
  split(text, max = this.burstMax) {
    const raw = String(text || '').trim();
    if (!raw) return [];

    // 抽取出 CQ:image 码，防止被分句切割
    const cqImages = [];
    const sanitized = raw.replace(/\[CQ:image,[^\]]+\]/g, (match) => {
      const token = `__CQ_IMAGE_${cqImages.length}__`;
      cqImages.push(match);
      return `\n${token}\n`;
    });

    // 保护英文单词、数字、中英文混排之间的普通空格，避免把 Hello World / RTX 4070 拆碎！
    const protectedText = sanitized
      .replace(/([a-zA-Z0-9_.-])\s+([a-zA-Z0-9_.-])/g, '$1\u200B$2')
      .replace(/([\u4e00-\u9fa5])\s+([a-zA-Z0-9])/g, '$1\u200B$2')
      .replace(/([a-zA-Z0-9])\s+([\u4e00-\u9fa5])/g, '$1\u200B$2');

    // 先按换行
    const parts = protectedText.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    const out = [];
    for (const p of parts) {
      if (p.startsWith('__CQ_IMAGE_')) { out.push(p); continue; }

      // 1) 先按句末标点切 —— 语义边界优先
      const sentences = p
        .split(/(?<=[。！？!?…~]+)(?![。！？!?…~])/)
        .map((s) => s.trim())
        .filter(Boolean);

      for (const s of sentences) {
        // 检查里面是否有明显的逗号、分号或中文分句空格（英文/数字间空格已提前保护）
        const clauses = s.split(/(?<=[，,；;、])|\s+/).map((x) => x.trim().replace(/[，,；;、]+$/, '')).filter(Boolean);

        // 如果没有逗号/分号/空格，直接就是单句
        if (clauses.length <= 1) {
          out.push(s);
          continue;
        }

        let buf = '';
        for (const c of clauses) {
          if (!buf) {
            buf = c;
            continue;
          }
          // 如果前一个积累块有效字数少于 4 字（如 "哈哈"、"行吧"），或者当前块只有 1~2 个字，合并
          const bufLen = [...buf.replace(/\u200B/g, '').replace(/\s+/g, '')].length;
          const cLen = [...c.replace(/\u200B/g, '').replace(/\s+/g, '')].length;
          if (bufLen < 4 || cLen < 3) {
            buf += ' ' + c;
          } else {
            out.push(buf);
            buf = c;
          }
        }
        if (buf) out.push(buf);
      }
    }

    // 合并太短的碎片（<5个字且合并后不超过22字）
    const merged = [];
    for (const s of out) {
      const last = merged[merged.length - 1];
      if (s.startsWith('__CQ_IMAGE_') || last?.startsWith('__CQ_IMAGE_')) {
        merged.push(s);
      } else {
        const lastLen = last ? [...last.replace(/\u200B/g, '').replace(/\s+/g, '')].length : 0;
        const sLen = [...s.replace(/\u200B/g, '').replace(/\s+/g, '')].length;
        if (last && lastLen < 5 && (lastLen + sLen <= 22)) {
          merged[merged.length - 1] = last + (/[，,；;、]$/.test(last) ? '' : ' ') + s;
        } else {
          merged.push(s);
        }
      }
    }
    // 超量时主动精简：真人老群友在群里从不长篇大论刷屏。
    // 如果切出来的句子超过 max（默认 2 条），智能提炼前 max 条核心表述，多余长句废话直接丢弃
    let res = merged;
    if (merged.length > max) {
      const textParts = merged.filter((p) => !p.startsWith('__CQ_IMAGE_'));
      const imgParts = merged.filter((p) => p.startsWith('__CQ_IMAGE_'));
      const textLimit = Math.max(1, max - imgParts.length);

      const head = [];
      let cur = '';
      for (const part of textParts) {
        if (head.length >= textLimit) break;
        if (!cur) {
          cur = part;
        } else {
          const curLen = [...cur.replace(/\u200B/g, '').replace(/\s+/g, '')].length;
          const partLen = [...part.replace(/\u200B/g, '').replace(/\s+/g, '')].length;
          if (curLen + partLen <= 24 && head.length + 1 < textLimit) {
            cur += ' ' + part;
          } else {
            head.push(cur);
            cur = part;
          }
        }
      }
      if (cur && head.length < textLimit) head.push(cur);

      // 单条超过 32 字进行自然断句截取，坚决不发大长段
      const trimmedHead = head.map((s) => {
        if (s.length > 32) {
          const cut = s.slice(0, 32).replace(/[，,；;、\s][^，,；;、\s]*$/, '');
          return (cut.length >= 8 ? cut : s.slice(0, 32));
        }
        return s;
      });

      res = [...trimmedHead.filter(Boolean), ...imgParts];
    }

    // 还原 CQ:image 码与空格，并去掉句尾句号
    return res.map((part) => {
      let back = part.replace(/\u200B/g, ' ');
      back = back.replace(/__CQ_IMAGE_(\d+)__/g, (_, idx) => cqImages[Number(idx)] || '');
      return this.stripTail(back);
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
  async say(text, { setTyping, send, sleep } = {}) {
    const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const parts = Array.isArray(text) ? text.map((s) => String(s)) : this.split(text);
    if (!parts.length) return { sent: 0, parts: [] };

    if (!this.enabled) {
      for (const p of parts) await send(p);
      return { sent: parts.length, parts };
    }

    let sent = 0;
    for (let i = 0; i < parts.length; i++) {
      const p = this.typoize(parts[i]);
      // 1) 先"正在输入"
      if (setTyping) { try { await setTyping(true); } catch { /* 有些平台不支持，忽略 */ } }
      await wait(this.typingMsFor(p));
      if (setTyping) { try { await setTyping(false); } catch {} }
      // 2) 发出去
      await send(p);
      sent++;
      // 3) 条间停顿
      if (i < parts.length - 1) await wait(this.gapMs());
    }
    return { sent, parts };
  }
}

export default Humanizer;
