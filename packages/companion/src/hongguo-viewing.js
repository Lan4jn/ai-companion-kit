// Pure evidence assessment: callers must provide observations; this module never
// controls a device, records audio, or asserts that a real session occurred.
export function assessViewing({ before, after, playbackBefore, playbackAfter } = {}) {
  const validFrame = frame => frame && Number.isFinite(frame.capturedAt) &&
    typeof frame.frameId === 'string' && frame.frameId.trim() &&
    typeof frame.description === 'string' && frame.description.trim();
  const verified = Boolean(validFrame(before) && validFrame(after) &&
    after.capturedAt > before.capturedAt && before.frameId !== after.frameId &&
    typeof playbackBefore?.episodeId === 'string' && playbackBefore.episodeId.trim() &&
    playbackBefore.episodeId === playbackAfter?.episodeId &&
    Number.isFinite(playbackBefore.positionMs) && playbackBefore.positionMs >= 0 &&
    Number.isFinite(playbackAfter?.positionMs) && playbackAfter.positionMs > playbackBefore.positionMs);
  const frames = [before, after].filter(validFrame);
  return {
    verified,
    evidence: {
      frames: frames.map(({ capturedAt, frameId, description }) => ({ capturedAt, frameId, description })),
      subtitles: frames.flatMap(frame => Array.isArray(frame.subtitles) ? frame.subtitles.filter(s => typeof s === 'string' && s.trim()) : []),
      audio: null,
    },
    limitations: ['未采集音频，不能推断声音、语气或无字幕的对白。', ...(verified ? ['核验依赖调用方提供的画面与播放位置，不能独立证明来源真实。'] : ['缺少足够的前后画面或同集播放进度证据，不能声称已观看。'])],
  };
}

// Caller owns persistence; only explicit, attributed preferences are remembered.
export function updateInterest(memory = {}, observation = {}) {
  const { topic, preference, source } = observation;
  if (typeof topic !== 'string' || !topic.trim() || !['喜欢', '不喜欢'].includes(preference) || typeof source !== 'string' || !source.trim()) return { ...memory };
  return { ...memory, [topic.trim()]: { preference, source: source.trim() } };
}

// A recommendation, not a device operation or an instruction to bypass prompts.
export function decideNext(assessment, memory = {}, topic) {
  if (!assessment?.verified) return { action: 'observe', reason: '观看证据不足' };
  const preference = Object.hasOwn(memory, topic) ? memory[topic]?.preference : undefined;
  if (preference === '喜欢') return { action: 'continue', reason: '符合已记录兴趣' };
  if (preference === '不喜欢') return { action: 'stop', reason: '不符合已记录兴趣' };
  return { action: 'undecided', reason: '缺少明确兴趣' };
}
