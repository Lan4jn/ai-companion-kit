import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

// OCR is screen text, not verified dialogue or a complete plot.
export async function rememberHongguo({ dir, brain, assessment, timeoutMs = 30000 }) {
  if (!assessment?.verified || !dir) return { status: 'unavailable' };
  const evidence = assessment.evidence;
  if (!Array.isArray(evidence?.screenText) || !evidence.screenText.flat().some(x => typeof x === 'string' && x.trim()) || !evidence.playback?.episodeId) return { status: 'unavailable' };
  let timer, thought;
  try {
    const raw = await Promise.race([
      Promise.resolve().then(() => brain.complete({ system: '只依据不可靠的屏幕OCR选择是否感兴趣；不是音频或可靠字幕，不要臆造剧情、剧名或对白。只输出JSON。', prompt: `屏幕OCR：${JSON.stringify(evidence.screenText).slice(0, 4000)}\n返回 {"interested":true或false,"summary":"仅概括可见文字","keywords":["相关词"]}`, json: true, max_tokens: 400, temperature: 0.4 })),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000); }),
    ]);
    thought = typeof raw === 'string' ? JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')) : null;
  } catch { return { status: 'understanding_unavailable' }; }
  finally { clearTimeout(timer); }
  if (typeof thought?.interested !== 'boolean') return { status: 'understanding_unavailable' };
  if (!thought.interested) return { status: 'not_interested' };
  if (typeof thought.summary !== 'string' || !thought.summary.trim() || !Array.isArray(thought.keywords)) return { status: 'understanding_unavailable' };
  const record = { source: '红果屏幕OCR（可能有误，非音频或确认字幕）', episodeId: evidence.playback.episodeId, progress: evidence.playback.source === 'screen-progress' ? { fraction: evidence.playback.progress } : { positionMs: evidence.playback.positionMs }, capturedAt: evidence.frames.at(-1).capturedAt, screenText: evidence.screenText, audio: null, summary: thought.summary.trim().slice(0, 500), keywords: thought.keywords.filter(x => typeof x === 'string' && x.trim()).slice(0, 10).map(x => x.trim().slice(0, 100)) };
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await appendFile(path.join(dir, 'hongguo-viewing.jsonl'), JSON.stringify(record) + '\n', { mode: 0o600 });
    return { status: 'saved' };
  } catch { return { status: 'save_failed' }; }
}

export async function recallHongguo(dir, query) {
  const q = typeof query === 'string' ? query.trim() : '';
  if (!q || !dir) return [];
  let content;
  try { content = await readFile(path.join(dir, 'hongguo-viewing.jsonl'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return content.split('\n').reverse().flatMap(line => {
    try {
      const r = JSON.parse(line);
      if (typeof r.source !== 'string' || typeof r.episodeId !== 'string' || typeof r.summary !== 'string' || !Array.isArray(r.keywords)) return [];
      return [r.summary, ...r.keywords].some(word => typeof word === 'string' && word.trim().length >= 2 && (q.includes(word.trim()) || word.trim().includes(q))) ? [r] : [];
    } catch { return []; }
  }).slice(0, 3);
}
