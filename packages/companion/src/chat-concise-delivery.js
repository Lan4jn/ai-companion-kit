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
export function safeReplyParts(parts) {
  if (!Array.isArray(parts) || parts.length < 1 || parts.length > 3 || parts.some(p => typeof p !== 'string' || !p.trim())) return false;
  const text = parts.join('');
  return [...text].length <= 50;
}

export function safeTransportMessage(message) {
  if (typeof message === 'string') return safeReplyParts([message]);
  if (!Array.isArray(message) || !message.length) return false;
  let text = '';
  for (const segment of message) {
    if (segment?.type === 'text' && typeof segment.data?.text === 'string') text += segment.data.text;
    else if (!['image', 'at', 'record'].includes(segment?.type)) return false;
  }
  return text ? safeReplyParts([text]) : true;
}

export function createConciseBudget() {
  let used = 0, regenerated = false;
  return Object.freeze({ take() { return used < 5 ? ++used : 0; }, takeRegeneration() { if (regenerated) return false; regenerated = true; return true; } });
}

export async function prepareConciseReply(text, rewrite, verify, {softLimit = 50, budget = createConciseBudget(), regenerate} = {}) {
  if (typeof text !== 'string' || !text) return {parts: []};
  const original = paragraphs(text);
  const prepared = prepareChatParts(text, new Humanizer());
  // Enforce the final bound even for protected markup and links.
  const limit = Math.min(50, Number.isFinite(softLimit) && softLimit > 0 ? softLimit : 50);
  if (original.length <= 3 && !prepared.capacityExceeded && safeReplyParts(original) && safeReplyParts(prepared.parts) && [...original.join('').replace(/\[CQ:(?:image|at|record),[^\]]*\]/g, '')].length <= limit) return {parts: prepared.parts};
  let attempt, feedback;
  while ((attempt = budget.take())) {
    const started = Date.now();
    const failed = (stage, error) => {
      feedback = stage;
      const reason = ['http_status', 'invalid_response'].includes(error?.conciseReason) ? error.conciseReason : 'exception';
      const status = reason === 'http_status' && Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599 ? ` http_status=${error.status}` : '';
      console.warn(`   [Concise] stage=${stage} attempt=${attempt} elapsed_ms=${Math.max(0, Date.now() - started)}${error ? ` reason=${reason}${status}` : ''}`);
    };
    let candidate;
    try { candidate = await rewrite(text, feedback); } catch (error) { failed('rewrite', error); continue; }
    if (typeof candidate !== 'string' || !candidate.trim()) { failed('empty'); continue; }
    const parts = paragraphs(candidate);
    if (!parts.length || parts.length > 3) { failed('format'); continue; }
    if (!safeReplyParts(parts) || [...parts.join('')].length > limit) { failed('too_long'); continue; }
    if (!sameLiterals(text, candidate)) { failed('literals'); continue; }
    // Every generated rewrite receives an independent semantic review, including
    // apparently exact regrouping; literal checks alone are not a semantic audit.
    if (typeof verify !== 'function') { failed('review_unavailable'); continue; }
    try {
      const verdict = await verify(text, candidate);
      if (verdict !== true) { failed(verdict === false ? 'review_rejected' : 'review_invalid'); continue; }
    } catch (error) { failed('review_error', error); continue; }
    return {parts, rewritten:true};
  }
  // One bounded, tool-free regeneration from the already obtained draft only.
  // Treat the draft as the authoritative complete record and review identically.
  if (typeof regenerate === 'function' && typeof verify === 'function' && budget.takeRegeneration?.()) {
    try {
      const candidate = await regenerate(text);
      const parts = typeof candidate === 'string' ? paragraphs(candidate) : [];
      if (safeReplyParts(parts) && [...parts.join('')].length <= limit && sameLiterals(text, candidate) && await verify(text, candidate) === true)
        return {parts, rewritten:true};
      console.warn('   [Concise] stage=regenerate_rejected');
    } catch { console.warn('   [Concise] stage=regenerate_error'); }
  }
  console.warn('   [Concise] stage=exhausted');
  return {parts: [], failed: true};
}
