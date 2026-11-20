import { Humanizer, prepareChatParts } from './humanize.js';

// Blank lines inside fenced code are content, not message boundaries.
export const paragraphs = text => {
  const fences = [...text.matchAll(/(`{3,}|~{3,})[^\r\n]*(?:[\s\S]*?\1|[\s\S]*$)/g)]
    .map(match => [match.index, match.index + match[0].length]);
  const parts = [];
  let start = 0;
  for (const separator of text.matchAll(/\r?\n[\t ]*\r?\n+/g)) {
    if (fences.some(([from, to]) => separator.index >= from && separator.index < to)) continue;
    const part = text.slice(start, separator.index);
    if (part.trim()) parts.push(part);
    start = separator.index + separator[0].length;
  }
  const last = text.slice(start);
  if (last.trim()) parts.push(last);
  return parts;
};
// These checks catch common literal changes, not semantic equivalence. The
// independent model review below is also fallible and is deliberately fail-closed.
const literals = text => (text.match(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\r\n]+`|\[CQ:[^\]]*\]|https?:\/\/[^\s<>）)]+|www\.[^\s<>）)]+|“[^”\n]+”|「[^」\n]+」|『[^』\n]+』|"[^"\n]+"|[-+]?\d+(?:[.,:]\d+)*(?:%|％)?/gu) || []).sort();
const sameLiterals = (a,b) => JSON.stringify(literals(a)) === JSON.stringify(literals(b));

// Count all textual material, including code and URLs; only actual CQ media/at
// segments are excluded. This conservative rule cannot hide prose in markup.
// limit 默认 50；科普类回答允许放宽到 80，由调用方显式传入，绝不默认放宽。
export const MAX_REPLY_LIMIT = 80;
const clampLimit = value => Math.max(1, Math.min(MAX_REPLY_LIMIT, Number.isFinite(value) && value > 0 ? value : 50));

export function safeReplyParts(parts, limit = 50) {
  if (!Array.isArray(parts) || parts.length < 1 || parts.length > 3 || parts.some(p => typeof p !== 'string' || !p.trim())) return false;
  const CQ = /\[CQ:[^\]]*\]/g;
  // 图片是投递指令，不是正文：不占 50 码点预算，否则十几万字符的 base64
  // 会把整轮回复判死（她画了图/发了表情包，却一句话都发不出来）。
  // 文字和图片可以同一条气泡（"给你看"+图），只按文字部分算长度。
  const realImage = x => /base64:\/\//i.test(x) || /file=(?:https?:\/\/|\/|~)/i.test(x) || /\.(?:gif|jpe?g|png|webp|bmp|amr|silk|mp3|wav|ogg)/i.test(x);
  let attachments = 0, textTotal = 0, textParts = 0;
  for (const part of parts) {
    const imgs = part.match(/\[CQ:image,[^\]]*\]/g) || [];
    if (imgs.some(x => !realImage(x))) return false;      // 来路不明的图片 payload 仍拒
    const others = (part.match(CQ) || []).filter(x => !/^\[CQ:image,/.test(x));
    const badCq = x => /base64:\/\//i.test(x) || x.length > 300 || (x.length > 40 && !/file=(?:https?:\/\/|\/|~)/i.test(x));
    if (others.some(badCq)) return false;
    const body = part.replace(CQ, '');
    if (imgs.length && !body.trim()) { attachments++; continue; }
    textParts++; textTotal += [...body].length;
  }
  if (attachments > 2) return false;
  if (textParts === 0) return attachments >= 1;
  return textTotal <= clampLimit(limit);
}

export function safeTransportMessage(message, limit = 50) {
  if (typeof message === 'string') return safeReplyParts([message], limit);
  if (!Array.isArray(message) || !message.length) return false;
  let text = '';
  for (const segment of message) {
    if (segment?.type === 'text' && typeof segment.data?.text === 'string') text += segment.data.text;
    else if (!['image', 'at', 'record'].includes(segment?.type)) return false;
  }
  return text ? safeReplyParts([text], limit) : true;
}

export function createConciseBudget() {
  let used = 0, regenerated = false;
  return Object.freeze({ take() { return used < 5 ? ++used : 0; }, takeRegeneration() { if (regenerated) return false; regenerated = true; return true; } });
}

export async function prepareConciseReply(text, rewrite, verify, {softLimit = 50, budget = createConciseBudget(), regenerate} = {}) {
  if (typeof text !== 'string' || !text) return {parts: []};
  const CQ_RE = /\[CQ:[^\]]*\]/g;
  const cqCodes = text.match(CQ_RE) || [];
  // 改写模型是纯文本的，一看到 CQ 码就会整段丢掉；先摘出来，通过后再贴回去。
  const baseText = cqCodes.length ? text.replace(CQ_RE, '') : text;
  const attachCq = list => {
    if (!cqCodes.length) return list;
    const out = [...list];
    out[out.length - 1] = (out[out.length - 1] || '') + cqCodes.join('');
    return out;
  };
  const original = paragraphs(baseText);
  const prepared = prepareChatParts(baseText, new Humanizer());
  // Enforce the final bound even for protected markup and links.
  // 默认 50；科普类由调用方传 80（上限硬顶 80）
  const limit = clampLimit(Number.isFinite(softLimit) && softLimit > 0 ? softLimit : 50);
  if (original.length <= 3 && !prepared.capacityExceeded && safeReplyParts(original, limit) && safeReplyParts(prepared.parts, limit) && [...original.join('').replace(/\[CQ:(?:image|at|record),[^\]]*\]/g, '')].length <= limit) return {parts: attachCq(prepared.parts)};
  let attempt, feedback;
  const mustKeep = [];  // 上一轮被删掉的数字，下一轮点名要求保留
  while ((attempt = budget.take())) {
    const started = Date.now();
    const failed = (stage, error, detail = '') => {
      feedback = stage;
      const reason = ['http_status', 'invalid_response'].includes(error?.conciseReason) ? error.conciseReason : 'exception';
      const status = reason === 'http_status' && Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599 ? ` http_status=${error.status}` : '';
      console.warn(`   [Concise] stage=${stage} attempt=${attempt} elapsed_ms=${Math.max(0, Date.now() - started)}${error ? ` reason=${reason}${status}` : ''}${detail}`);
    };
    let candidate;
    try { candidate = await rewrite(baseText, feedback, mustKeep.length ? { mustKeep } : undefined); } catch (error) { failed('rewrite', error); continue; }
    if (typeof candidate !== 'string' || !candidate.trim()) { failed('empty'); continue; }
    const parts = paragraphs(candidate);
    if (!parts.length || parts.length > 3) { failed('format'); continue; }
    if (!safeReplyParts(parts, limit) || [...parts.join('')].length > limit) { failed('too_long'); continue; }
    if (!sameLiterals(baseText, candidate)) {
      // 只记数量，不记内容：下次再卡住能看出是数字、引号、链接还是代码被改了
      const before = literals(baseText), after = literals(candidate);
      const kind = x => /```|~~~/.test(x) ? 'code' : /^`/.test(x) ? 'inline' : /^\[CQ:/.test(x) ? 'cq' : /^https?:|^www\./.test(x) ? 'url' : /^\d|^[-+]?\d/.test(x) ? 'num' : 'quote';
      const lost = before.filter(x => !after.includes(x));
      for (const x of lost) if (kind(x) === 'num' && !mustKeep.includes(x) && mustKeep.length < 5) mustKeep.push(x);
      failed('literals', undefined, ` drift=${lost.length}${lost.length ? ` kinds=${[...new Set(lost.map(kind))].join(',')}` : ''}`); continue;
    }
    // Every generated rewrite receives an independent semantic review, including
    // apparently exact regrouping; literal checks alone are not a semantic audit.
    if (typeof verify !== 'function') { failed('review_unavailable'); continue; }
    try {
      const verdict = await verify(baseText, candidate);
      if (verdict !== true) { failed(verdict === false ? 'review_rejected' : 'review_invalid'); continue; }
    } catch (error) { failed('review_error', error); continue; }
    return {parts: attachCq(parts), rewritten:true};
  }
  // One bounded, tool-free regeneration from the already obtained draft only.
  // Treat the draft as the authoritative complete record and review identically.
  if (typeof regenerate === 'function' && typeof verify === 'function' && budget.takeRegeneration?.()) {
    try {
      const candidate = await regenerate(baseText);
      const parts = typeof candidate === 'string' ? paragraphs(candidate) : [];
      if (safeReplyParts(parts, limit) && sameLiterals(baseText, candidate) && await verify(baseText, candidate) === true) {
        return {parts: attachCq(parts), rewritten:true};
      }
      console.warn('   [Concise] stage=regenerate_rejected');
    } catch { console.warn('   [Concise] stage=regenerate_error'); }
  }
  console.warn('   [Concise] stage=exhausted');
  return {parts: [], failed: true};
}
