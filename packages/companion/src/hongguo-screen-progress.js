export function reconcileScreenEpisodes(a, b) {
  const parse = id => {
    if (typeof id !== 'string') return null;
    const m = id.match(/^(.+):第(\d+)集$/);
    if (!m) return null;
    return { title: m[1].replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, ''), episode: m[2] };
  };
  const x = parse(a), y = parse(b);
  if (!x || !y || x.episode !== y.episode || Math.min(x.title.length, y.title.length) < 10) return false;
  let row = Array.from({ length: y.title.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.title.length; i++) {
    const next = [i];
    for (let j = 1; j <= y.title.length; j++) next[j] = Math.min(next[j-1]+1, row[j]+1, row[j-1]+(x.title[i-1] === y.title[j-1] ? 0 : 1));
    row = next;
  }
  return row[y.title.length] <= 2;
}

export function screenEpisodeId(lines) {
  if (!Array.isArray(lines)) return null;
  const episodes = lines.flatMap(line => [...line.matchAll(/第\s*(\d+)\s*集/g)].map(m => `第${m[1]}集`));
  const titles = lines.map(line => line.match(/^\s*([\u4e00-\u9fff，,！!？?《》\w]{5,50})\s*[>›]\s*$/)?.[1]).filter(Boolean);
  return episodes.length === 1 && titles.length === 1 ? `${titles[0]}:${episodes[0]}` : null;
}

// Calibrated 1920x1080 landscape and 1080x1920 portrait players; reject ambiguity.
export function detectPlayhead({ data, width, height } = {}) {
  const portrait = width === 1080 && height === 1920;
  if ((!portrait && (width !== 1920 || height !== 1080)) || !Buffer.isBuffer(data) || data.length !== width * height * 3) return null;
  const left = 28, right = portrait ? 1052 : 1892, rows = portrait ? [1818,1819,1820,1821] : [978,979,980,981,982];
  const white = (x, y) => { const i = (y * width + x) * 3; return data[i] > 220 && data[i+1] > 220 && data[i+2] > 220; };
  const runs = []; let start = null;
  for (let x = left; x <= right; x++) {
    const hit = x < right && rows.every(y => white(x,y));
    if (hit && start === null) start = x;
    if (!hit && start !== null) { if (x - start >= 2 && x - start <= 12) runs.push((start+x-1)/2); start = null; }
  }
  return runs.length === 1 ? (runs[0] - left) / (right - left) : null;
}

// Visual progress is a fraction, not a fabricated playback timestamp.
export function assessScreenProgress(a, b) {
  return Boolean(a && b && typeof a.episodeId === 'string' && a.episodeId && (a.episodeId === b.episodeId || reconcileScreenEpisodes(a.episodeId, b.episodeId)) &&
    Number.isFinite(a.progress) && Number.isFinite(b.progress) && a.progress >= 0 && b.progress <= 1 &&
    b.progress > a.progress + 0.002 && b.progress - a.progress < 0.25 &&
    Number.isFinite(a.capturedAt) && Number.isFinite(b.capturedAt) && b.capturedAt > a.capturedAt &&
    typeof a.frameId === 'string' && a.frameId && b.frameId && a.frameId !== b.frameId);
}
