// 小鱼的表情包库：收藏群友发的、从视频截的，会自己挑着用
//
// 存储： data/stickers/index.json  +  data/stickers/*.jpg|png|gif|webp
// 判断表情包靠 QQ 消息段的 sub_type：1 = 表情包，0 = 普通图片；mface = 商城表情
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const DIR = process.env.STICKER_DIR || './data/stickers';
const indexFile = () => path.join(DIR, 'index.json');

let cache = null;

function loadIndex() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(indexFile(), 'utf8'));
    cache = Array.isArray(raw) ? raw : [];
  } catch {
    cache = [];
  }
  return cache;
}

function saveIndex() {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(indexFile(), JSON.stringify(cache || [], null, 1), 'utf8');
}

async function download(url, timeoutMs = 15000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 300) throw new Error('too small: ' + buf.length);
  return buf;
}

function extOf(buf, url = '') {
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  if (buf[0] === 0x52 && buf[1] === 0x49) return 'webp';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  const m = String(url).match(/\.(jpg|jpeg|png|gif|webp)(?:\?|$)/i);
  return m ? m[1].toLowerCase() : 'jpg';
}

function newId() {
  return 's_' + Date.now().toString(36) + '_' + crypto.randomBytes(2).toString('hex');
}

/** 下载一张图存进库 */
export async function addSticker(url, opts = {}) {
  const { tags = [], source = '', sourceUrl = '', maxBytes = 3 * 1024 * 1024 } = opts;
  let buf;
  try {
    buf = await download(url);
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 160) };
  }
  if (buf.length > maxBytes) return { ok: false, error: 'too large: ' + buf.length };

  const ext = extOf(buf, url);
  const id = newId();
  const file = `${id}.${ext}`;
  await fsp.mkdir(DIR, { recursive: true });
  await fsp.writeFile(path.join(DIR, file), buf);

  const idx = loadIndex();
  idx.push({
    id, file, bytes: buf.length, tags, source,
    source_url: sourceUrl || url,
    added_at: Date.now(), use_count: 0, last_used: null,
  });
  saveIndex();
  return { ok: true, id, file, bytes: buf.length };
}

/**
 * 从消息段里捡表情包（只在群聊调用）
 * 只认 QQ 标记为表情的：image.sub_type === 1、mface
 */
export async function collectFromSegs(segs, opts = {}) {
  const { source = '', maxPerMsg = 2, sourceUrls = [] } = opts;
  if (!Array.isArray(segs) || !segs.length) return { collected: 0, skipped: 0 };

  const idx = loadIndex();
  const known = new Set(idx.map((s) => s.source_url).filter(Boolean));
  let collected = 0;
  let skipped = 0;

  for (const s of segs) {
    if (collected >= maxPerMsg) break;
    if (!s) continue;

    let url = '';
    if (s.type === 'image') {
      const st = Number(s.data?.sub_type ?? 0);
      if (st !== 1) continue; // 普通图片不收
      url = s.data?.url || '';
    } else if (s.type === 'mface') {
      url = s.data?.url || '';
    } else {
      continue;
    }
    if (!url) continue;
    if (known.has(url) || sourceUrls.includes(url)) { skipped++; continue; }

    const r = await addSticker(url, { tags: ['群友发的'], source, sourceUrl: url });
    if (r.ok) { collected++; known.add(url); } else { skipped++; }
  }
  return { collected, skipped };
}

/** 按标签随机挑一张（挑不到就全库随机）
 *
 * minAgeMs：刚收进来的表情包不参与挑选。
 * 不设这个的话会出现"群友发了张图 → 她存进库 → 15 秒后又把同一张图发回去"，
 * 看起来就像复读机，非常假。
 */
export function pickSticker({ tag = '', excludeIds = [], minAgeMs = 30 * 60e3 } = {}) {
  const idx = loadIndex();
  const excl = new Set(excludeIds);
  const now = Date.now();
  // 预置/官方表情包库不受新接收图的 30 分钟冷却限制
  const fresh = (s) => s.source === 'dsh-meme-pack' || s.source === 'seed' || !s.added_at || now - Number(s.added_at) >= minAgeMs;
  let pool = idx.filter((s) => !excl.has(s.id) && fresh(s));
  if (!pool.length) pool = idx.filter((s) => !excl.has(s.id));  // 全库只有新图时退回，别挑不到

  if (tag) {
    const norm = String(tag).trim().toLowerCase();
    const byTag = pool.filter((s) => {
      const matchTag = (s.tags || []).some((t) => {
        const tl = String(t).toLowerCase();
        return tl === norm || tl.includes(norm) || norm.includes(tl);
      });
      const matchCap = s.caption && s.caption.toLowerCase().includes(norm);
      const matchKw = s.keywords && s.keywords.toLowerCase().includes(norm);
      return matchTag || matchCap || matchKw;
    });
    if (byTag.length) pool = byTag;
  }
  if (!pool.length) pool = idx;
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

export async function readStickerBase64(sticker) {
  if (!sticker?.file) return '';
  const buf = await fsp.readFile(path.join(DIR, sticker.file));
  return buf.toString('base64');
}

export function markUsed(id) {
  const idx = loadIndex();
  const it = idx.find((s) => s.id === id);
  if (it) {
    it.use_count = (it.use_count || 0) + 1;
    it.last_used = Date.now();
    saveIndex();
  }
}

export function stickerStats() {
  const idx = loadIndex();
  return {
    total: idx.length,
    bytes: idx.reduce((a, b) => a + (b.bytes || 0), 0),
    tags: [...new Set(idx.flatMap((s) => s.tags || []))],
    recent: idx.slice(-3).map((s) => ({ id: s.id, tags: s.tags })),
  };
}

/** 从视频里抽几帧当表情包（time 给具体秒数，不给就均匀） */
export async function extractFromVideo(videoPath, opts = {}) {
  const { count = 3, times = [], width = 260, minBytes = 2500, maxBytes = 1.5 * 1024 * 1024 } = opts;
  if (!fs.existsSync(videoPath)) return { ok: false, error: '视频不存在: ' + videoPath };

  const tmpDir = path.join(DIR, '_tmp_' + Date.now());
  await fsp.mkdir(tmpDir, { recursive: true });
  const frames = [];

  try {
    const grab = async (t, name) => {
      const f = path.join(tmpDir, name);
      try {
        await run('ffmpeg', [
          '-v', 'error', '-ss', String(t), '-i', videoPath,
          '-vframes', '1', '-vf', `scale=${width}:-1`, '-q:v', '4', f,
        ], { timeout: 25000 });
        if (fs.existsSync(f)) frames.push(f);
      } catch { /* 单帧失败无所谓 */ }
    };

    if (times.length) {
      for (let i = 0; i < Math.min(times.length, count); i++) await grab(times[i], `f${i}.jpg`);
    }
    if (!frames.length) {
      let dur = 60;
      try {
        const { stdout } = await run('ffprobe', [
          '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', videoPath,
        ], { timeout: 15000 });
        dur = parseFloat(stdout.trim()) || 60;
      } catch { /* 用默认时长 */ }
      for (let i = 0; i < count; i++) {
        await grab(((dur / (count + 1)) * (i + 1)).toFixed(2), `f${i}.jpg`);
      }
    }

    const saved = [];
    for (const f of frames) {
      try {
        const buf = await fsp.readFile(f);
        if (buf.length < minBytes || buf.length > maxBytes) continue;
        const id = newId();
        const file = `${id}.jpg`;
        await fsp.writeFile(path.join(DIR, file), buf);
        const idx = loadIndex();
        idx.push({
          id, file, bytes: buf.length, tags: ['视频截的'], source: 'video',
          source_url: '', added_at: Date.now(), use_count: 0, last_used: null,
        });
        saveIndex();
        saved.push({ id, file, bytes: buf.length });
      } catch { /* 跳过坏的 */ }
    }
    return { ok: saved.length > 0, saved, tried: frames.length };
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

export default {
  addSticker, collectFromSegs, pickSticker,
  readStickerBase64, markUsed, stickerStats, extractFromVideo,
};
