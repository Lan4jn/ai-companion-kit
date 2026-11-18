// 把一条回复拆成最多 3 个独立气泡发出去。
// 只在自然的断点拆：连续空格（她自己的分句习惯）、句末标点。拆出来太碎的并回去，
// 拆分只负责自然断句；最终总长度和发送条数由简洁发送边界校验。

export const MAX_PARTS = 3;
const MIN_SPLIT_LEN = 20;   // 整句太短就不拆
const MIN_PART_LEN = 8;     // 单个气泡至少这么长，否则并回去

function cpLen(s) {
  return [...String(s || '')].length;
}

// 连续空格是模型常用的分句符；按位置切，保留原文（不重组，避免丢逗号）
function splitByGap(text) {
  return String(text).split(/\s{2,}/).map((s) => s.trim()).filter(Boolean);
}

function splitBySentenceEnd(text) {
  const out = [];
  let buf = '';
  for (const ch of [...String(text)]) {
    buf += ch;
    if ('。！？!?'.includes(ch)) { out.push(buf.trim()); buf = ''; }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}

// 段数超了就合并最短的相邻两段；太碎的段也并到相邻段去
function coalesce(parts, maxParts) {
  const list = [...parts];
  while (list.length > maxParts) {
    let idx = 0; let best = Infinity;
    for (let i = 0; i < list.length - 1; i++) {
      const sum = cpLen(list[i]) + cpLen(list[i + 1]);
      if (sum < best) { best = sum; idx = i; }
    }
    list.splice(idx, 2, `${list[idx]} ${list[idx + 1]}`.trim());
  }
  for (let i = list.length - 1; i > 0; i--) {
    if (cpLen(list[i]) < MIN_PART_LEN || cpLen(list[i - 1]) < MIN_PART_LEN) {
      list.splice(i - 1, 2, `${list[i - 1]} ${list[i]}`.trim());
    }
  }
  return list.filter(Boolean);
}


// 含 CQ 码时：CQ 码单独成一段，其余文本按常规规则拆，最后整体不超过 maxParts 条
function splitWithCq(raw, maxParts) {
  const chunks = [];
  const re = /\[CQ:[^\]]+\]/g;
  let last = 0; let m;
  while ((m = re.exec(raw)) !== null) {
    const before = raw.slice(last, m.index).trim();
    if (before) chunks.push({ text: before });
    chunks.push({ cq: m[0] });
    last = m.index + m[0].length;
  }
  const tail = raw.slice(last).trim();
  if (tail) chunks.push({ text: tail });

  // 文本段各自内部再按断点拆细
  const expanded = [];
  for (const c of chunks) {
    if (c.cq) { expanded.push(c.cq); continue; }
    const sub = splitPlain(c.text, maxParts);
    for (const t of sub) expanded.push(t);
  }

  // 合并太碎的纯文本气泡（不动 CQ 码段），保证不超过 maxParts
  const merged = [];
  for (const part of expanded) {
    const prev = merged[merged.length - 1];
    const isCq = /^\[CQ:/.test(part);
    const prevIsCq = prev !== undefined && /^\[CQ:/.test(prev);
    if (prev !== undefined && !isCq && !prevIsCq && (cpLen(part) < MIN_PART_LEN || cpLen(prev) < MIN_PART_LEN)) {
      merged[merged.length - 1] = `${prev} ${part}`.trim();
    } else {
      merged.push(part);
    }
  }
  while (merged.length > maxParts) {
    let idx = 0; let best = Infinity;
    for (let i = 0; i < merged.length - 1; i++) {
      const a = /^\[CQ:/.test(merged[i]) ? 0 : cpLen(merged[i]);
      const b = /^\[CQ:/.test(merged[i + 1]) ? 0 : cpLen(merged[i + 1]);
      if (a + b < best) { best = a + b; idx = i; }
    }
    merged.splice(idx, 2, `${merged[idx]} ${merged[idx + 1]}`.trim());
  }
  return merged.filter(Boolean);
}

// 纯文本分句（给 splitWithCq 复用）
function splitPlain(text, maxParts) {
  const t = String(text || '').trim();
  if (!t) return [];
  if (cpLen(t) < MIN_SPLIT_LEN) return [t];
  const byGap = splitByGap(t);
  if (byGap.length > 1) {
    const merged = coalesce(byGap, maxParts);
    if (merged.length > 1) return merged;
  }
  const bySentence = splitBySentenceEnd(t);
  if (bySentence.length > 1) {
    const merged = coalesce(bySentence, maxParts);
    if (merged.length > 1) return merged;
  }
  return [t];
}

export function splitBurst(text, { maxParts = MAX_PARTS } = {}) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  if (cpLen(raw) < MIN_SPLIT_LEN) return [raw];
  // 带 CQ 码（表情包图片 / @）：先把 CQ 码摘出来当独立气泡，文本部分照常分句，最后再合起来
  if (/\[CQ:[^\]]+\]/.test(raw)) return splitWithCq(raw, maxParts);

  // 模型自己给了多行，直接按行
  const lines = raw.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (lines.length > 1) return coalesce(lines, maxParts).slice(0, maxParts);

  const byGap = splitByGap(raw);
  if (byGap.length > 1) {
    const merged = coalesce(byGap, maxParts);
    if (merged.length > 1) return merged.slice(0, maxParts);
  }

  const bySentence = splitBySentenceEnd(raw);
  if (bySentence.length > 1) {
    const merged = coalesce(bySentence, maxParts);
    if (merged.length > 1) return merged.slice(0, maxParts);
  }

  return [raw];
}


// 隔离版保留原始字符；@ 与同一句文字作为整体，图片可独立分条。
// 原始导出默认行为不变；这里的最大条数通过合并相邻气泡保证。
export function splitBurstPreserving(text, { maxParts = MAX_PARTS } = {}) {
  const raw = String(text ?? '');
  if (!raw) return [];
  const limit = Math.min(MAX_PARTS, Math.max(1, Math.floor(maxParts) || 1));
  const chunks = [];
  const cq = /\[CQ:(?!at(?:,|\]))[^\]]+\]/gi;
  let start = 0;
  const addText = (segment) => {
    if (!segment) return;
    // 保守保护 @：不在含 @ 的文本段内部切分。
    if (/\[CQ:at(?:,|\])/i.test(segment)) { chunks.push(segment); return; }
    const proposed = splitBurst(segment, { maxParts: limit });
    let pos = 0;
    const found = [];
    for (const part of proposed) {
      const index = segment.indexOf(part, pos);
      if (index < 0 || /\S/u.test(segment.slice(pos, index))) { chunks.push(segment); return; }
      found.push([index, index + part.length]);
      pos = index + part.length;
    }
    if (!found.length || /\S/u.test(segment.slice(pos))) { chunks.push(segment); return; }
    for (let i = 0; i < found.length; i++) {
      chunks.push(segment.slice(i ? found[i][0] : 0, i + 1 < found.length ? found[i + 1][0] : segment.length));
    }
  };
  for (const m of raw.matchAll(cq)) {
    addText(raw.slice(start, m.index));
    chunks.push(m[0]);
    start = m.index + m[0].length;
  }
  addText(raw.slice(start));
  // 单独的空白不是有效气泡，合并到邻段而不丢字符。
  for (let i = chunks.length - 1; i >= 0; i--) {
    if (!chunks[i].trim() && chunks.length > 1) {
      if (i + 1 < chunks.length) { chunks[i + 1] = chunks[i] + chunks[i + 1]; chunks.splice(i, 1); }
      else { chunks[i - 1] += chunks[i]; chunks.splice(i, 1); }
    }
  }
  while (chunks.length > limit) {
    let idx = 0, best = Infinity;
    for (let i = 0; i < chunks.length - 1; i++) {
      const size = cpLen(chunks[i]) + cpLen(chunks[i + 1]);
      if (size < best) { best = size; idx = i; }
    }
    chunks.splice(idx, 2, chunks[idx] + chunks[idx + 1]);
  }
  return chunks;
}
