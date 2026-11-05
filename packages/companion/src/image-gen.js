/**
 * 生图 —— 画出来、存下来、建索引，以后要用先查再决定重画。
 *
 * 设计要点：
 *   1. 每张图落本地 data/generated/YYYY-MM/<hash>.png，不依赖远端链接过期
 *   2. SQLite 建索引（data/images.db），记 prompt / tags / 谁用过 / 用过几次
 *   3. 生成和发送分开：generate_image 只负责画+入库，send_image 才发出去
 *   4. 复用还是重画由她自己判断——find_image 返回候选，她看过再决定
 *
 * 多驱动：ark（火山方舟 Seedream）/ openai（兼容 /v1/images/generations）
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getBalanceCached } from './ark-billing.js';

let Database = null;
try { Database = (await import('better-sqlite3')).default; } catch {}

let db = null;
let root = '';
let genDir = '';
let cfg = { enabled: false, default: '', providers: {} };
let initialized = false;
let notifyFn = null;   // 由 index.js 注入：余额告急时怎么喊人
let lastAlertAt = 0;

export function initImageGen({ dataDir, cfg: c, notify = null } = {}) {
  root = path.resolve(dataDir || path.join(process.cwd(), 'data'));   // 绝对化，服务 cwd 变了也不会读错文件
  genDir = path.join(root, 'generated');
  cfg = {
    enabled: c?.enabled !== false,
    default: c?.default || 'ark',
    providers: c?.providers || {},
    waitMs: c?.waitMs,   // 之前漏了，配置里写的 90 秒没能生效，一直用默认 60 秒
    lowBalance: c?.lowBalance,   // 余额告警阈值
  };
  try { fs.mkdirSync(genDir, { recursive: true }); } catch {}

  if (!Database) {
    console.log('[ImageGen] better-sqlite3 不可用，生图功能关闭');
    cfg.enabled = false;
    return;
  }

  try {
    db = new Database(path.join(root, 'images.db'));
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT UNIQUE NOT NULL,
        prompt TEXT NOT NULL,
        tags TEXT DEFAULT '',
        provider TEXT DEFAULT '',
        model TEXT DEFAULT '',
        width INTEGER DEFAULT 0,
        height INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        used_count INTEGER DEFAULT 0,
        last_used INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_images_created ON images(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_images_used ON images(used_count DESC);
    `);
    // 老库补列：kind 用来分图库类型（插画/表情/壁纸/头像/场景）
    const cols = db.prepare(`PRAGMA table_info(images)`).all().map((c) => c.name);
    if (!cols.includes('kind')) db.exec(`ALTER TABLE images ADD COLUMN kind TEXT DEFAULT 'illustration'`);
    notifyFn = typeof notify === 'function' ? notify : null;
  initialized = true;
    const n = db.prepare('SELECT COUNT(*) AS c FROM images').get().c;
    console.log(`[ImageGen] 图库已就绪：${n} 张，默认驱动 ${cfg.default}`);
  } catch (e) {
    console.error('[ImageGen] 初始化失败：' + (e?.message || e));
    cfg.enabled = false;
  }
}

export function isImageGenReady() {
  return initialized && cfg.enabled;
}

function pickProvider(name) {
  const key = name || cfg.default;
  const p = cfg.providers[key];
  if (!p || !p.apiKey) return null;
  return { name: key, ...p };
}

/** 调驱动画一张，返回 { buffer, ext } */
async function callProvider({ prompt, size, quality, providerName }) {
  const p = pickProvider(providerName);
  if (!p) throw new Error(`没有可用的生图驱动（${providerName || cfg.default} 未配置 apiKey）`);

  const base = String(p.baseUrl || '').replace(/\/+$/, '');
  const model = p.model || (p.type === 'ark' ? 'doubao-seedream-4-0-250828' : 'gpt-image-1');
  const sz = size || p.size || '1024x1024';

  if (p.type === 'mock') {
    // 1x1 透明 PNG，仅用于跑通链路
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    return { buffer: png, ext: 'png' };
  }

  // Responses API：gpt-image 系列只在这条路上，图以 base64 从 SSE 里流出来
  if (p.type === 'responses') {
    const chatModel = p.chatModel || 'gpt-6.1-sol';
    const imgModel = p.imageModel || model;
    const res = await fetch(`${base}/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.apiKey}` },
      body: JSON.stringify({
        model: chatModel,
        input: prompt,
        tools: [{
          type: 'image_generation',
          model: imgModel,
          ...(size ? { size } : {}),
          ...(quality ? { quality } : {}),
        }],
      }),
      signal: AbortSignal.timeout(p.timeoutMs || 300000),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`生图失败 ${res.status}: ${t.slice(0, 200)}`);
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let b64 = '';
    let errMsg = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = chunk.split('\n').find((l) => l.startsWith('data: '));
        if (!dataLine) continue;
        let d;
        try { d = JSON.parse(dataLine.slice(6)); } catch { continue; }
        if (d.type === 'response.output_item.done') {
          const item = d.item || {};
          if (typeof item.result === 'string' && item.result.length > 100) b64 = item.result;
          else if (item.image_url) b64 = `URL:${item.image_url}`;
        } else if (d.type === 'response.failed' || d.type === 'error') {
          errMsg = JSON.stringify(d.error || d).slice(0, 200);
        }
      }
      if (b64) break;
    }
    if (errMsg) throw new Error('生图失败：' + errMsg);
    if (!b64) throw new Error('生图流里没拿到图片');
    if (b64.startsWith('URL:')) {
      const u = b64.slice(4);
      const img = await fetch(u, { signal: AbortSignal.timeout(60000) });
      return { buffer: Buffer.from(await img.arrayBuffer()), ext: 'png' };
    }
    return { buffer: Buffer.from(b64, 'base64'), ext: 'png' };
  }

  let url, body;
  if (p.type === 'ark') {
    url = `${base}/images/generations`;
    body = { model, prompt, size: sz, response_format: 'url', watermark: false };
    if (quality) body.quality = quality;
  } else {
    url = `${base}/images/generations`;
    body = { model, prompt, size: sz, n: 1 };
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(p.timeoutMs || 120000),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`生图失败 ${res.status}: ${text.slice(0, 200)}`);

  let data;
  try { data = JSON.parse(text); } catch { throw new Error('生图返回不是 JSON'); }
  const item = data?.data?.[0];
  if (!item) throw new Error('生图返回里没有图片');

  if (item.b64_json) {
    return { buffer: Buffer.from(item.b64_json, 'base64'), ext: 'png' };
  }
  if (item.url) {
    const img = await fetch(item.url, { signal: AbortSignal.timeout(60000) });
    if (!img.ok) throw new Error(`图片下载失败 ${img.status}`);
    const buf = Buffer.from(await img.arrayBuffer());
    const ct = img.headers.get('content-type') || '';
    const ext = ct.includes('jpeg') ? 'jpg' : ct.includes('webp') ? 'webp' : 'png';
    return { buffer: buf, ext };
  }
  throw new Error('生图返回既没有 url 也没有 b64_json');
}

/** 火山驱动开画前看一眼余额；欠费或快见底就喊人（6 小时内只喊一次，别刷屏） */
async function warnIfBroke(providerName) {
  if (!notifyFn) return;
  // 只有走火山才查余额：GPT 那条线花的是订阅窗口，跟火山余额没关系
  const p = cfg.providers?.[providerName || cfg.default];
  if (!p || p.type !== 'ark') return;
  const bal = await getBalanceCached();
  console.log('[ImageGen] 余额检查:', bal ? `${bal.available} 元 / 阈值 ${cfg.lowBalance}` : '查不到');
  if (!bal) return;
  const low = Number(cfg.lowBalance ?? 5);
  let msg = '';
  if (bal.arrears > 0) {
    msg = `火山欠费了（可用 ${bal.available} 元，欠 ${bal.arrears} 元）。画图会直接 403，去费用中心充一下。`;
  } else if (bal.available < low) {
    msg = `火山只剩 ${bal.available} 元了，撑不了多久。要不充点？`;
  }
  if (!msg) return;
  if (Date.now() - lastAlertAt < 6 * 3600 * 1000) return;
  lastAlertAt = Date.now();
  try { notifyFn(msg); } catch (e) { console.log('[ImageGen] 余额提醒发不出去：' + e.message); }
}

/** 画一张并存进图库（内部实现，可能要几分钟） */
async function doGenerate({ prompt, tags = '', size, quality, kind, provider } = {}) {
  const text = String(prompt || '').trim();

  await warnIfBroke(provider);
  const { buffer, ext } = await callProvider({ prompt: text, size, quality, providerName: provider });
  if (!buffer?.length) throw new Error('图片数据为空');

  // hash 带上 prompt：同一张图配不同描述也算两条，不会被 ON CONFLICT 吃掉
  const hash = crypto.createHash('sha1').update(buffer).update(text).digest('hex').slice(0, 16);
  const month = new Date().toISOString().slice(0, 7);
  const dir = path.join(genDir, month);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${hash}.${ext}`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, buffer);

  const p = pickProvider(provider) || {};
  const info = db.prepare(`
    INSERT INTO images (path, prompt, tags, kind, provider, model, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET prompt = excluded.prompt
  `).run(path.relative(root, file), text, String(tags || ''), String(kind || 'illustration'), p.name || '', p.model || '', Date.now());

  const row = db.prepare('SELECT * FROM images WHERE path = ?').get(path.relative(root, file));
  console.log(`[ImageGen] 画好了 #${row.id}：${text.slice(0, 40)} → ${path.relative(root, file)}`);
  return row;
}

/** 对外入口：等一小会儿，画不完就转后台，别把对话卡死 */
export async function generateImage({ prompt, tags = '', size, quality, kind, provider, waitMs } = {}) {
  if (!isImageGenReady()) throw new Error('生图功能未就绪');
  const text = String(prompt || '').trim();
  if (!text) throw new Error('prompt 为空');

  const limit = Number(waitMs ?? cfg.waitMs ?? 60000);
  const job = doGenerate({ prompt: text, tags, size, quality, kind, provider });

  const row = await Promise.race([
    job,
    new Promise((r) => setTimeout(() => r(null), limit)),
  ]);

  if (row) return row;

  // 超时：交给后台继续画，画完入库
  job
    .then((r) => console.log(`[ImageGen] 后台画完 #${r.id}：${text.slice(0, 30)}`))
    .catch((e) => console.error('[ImageGen] 后台生图失败：' + (e?.message || e)));

  console.log(`[ImageGen] 超过 ${Math.round(limit / 1000)} 秒还没画完，转后台：${text.slice(0, 30)}`);
  return { pending: true, prompt: text, note: '还在画，画完会进图库' };
}

/** 扔掉图库里的一张图（文件 + 索引一起删） */
export function discardImage(id) {
  if (!isImageGenReady()) throw new Error('生图功能未就绪');
  const row = db.prepare(`SELECT * FROM images WHERE id = ?`).get(Number(id));
  if (!row) throw new Error(`图库里没有编号 ${id} 的图`);
  const abs = path.isAbsolute(row.path) ? row.path : path.join(root, row.path);
  try { if (fs.existsSync(abs)) fs.unlinkSync(abs); } catch (e) { console.log('[ImageGen] 删文件失败：' + e.message); }
  db.prepare(`DELETE FROM images WHERE id = ?`).run(Number(id));
  console.log(`[ImageGen] 扔掉 #${id}：${String(row.prompt || '').slice(0, 30)}`);
  return { id: Number(id), prompt: row.prompt, removed: true };
}

/** 按关键词找现成的图，返回候选让她自己挑 */
export function findImages({ query = '', limit = 5, kind = '' } = {}) {
  if (!isImageGenReady()) return [];
  const q = String(query || '').trim();
  const lim = Math.max(1, Math.min(10, Number(limit) || 5));

  const k = String(kind || '').trim();
  if (!q) {
    if (k) return db.prepare(`SELECT * FROM images WHERE kind = ? ORDER BY created_at DESC LIMIT ?`).all(k, lim);
    return db.prepare(`SELECT * FROM images ORDER BY created_at DESC LIMIT ?`).all(lim);
  }

  const words = q.split(/[\s,，、]+/).filter(Boolean).slice(0, 5);
  const conds = words.map(() => `(prompt LIKE ? OR tags LIKE ?)`).join(' OR ') + (k ? ' ' : '');
  const params = [];
  for (const w of words) { params.push(`%${w}%`, `%${w}%`); }
  if (k) { params.unshift(k); }
  params.push(lim);

  const rows = db.prepare(`
    SELECT * FROM images WHERE ${k ? 'kind = ? AND ' : ''}(${conds})
    ORDER BY used_count DESC, created_at DESC LIMIT ?
  `).all(...params);
  return rows;
}

export function getImage(id) {
  if (!isImageGenReady()) return null;
  const row = db.prepare(`SELECT * FROM images WHERE id = ?`).get(Number(id));
  if (!row) return null;
  // 库里存的是相对 data 的路径，发图/读文件要的是绝对路径
  // 老记录存相对路径，新记录存过绝对路径，两种都要认
  const absPath = path.isAbsolute(row.path) ? row.path : path.join(root, row.path);
  return { ...row, absPath };
}

function __oldGetImage(id) {
  if (!isImageGenReady()) return null;
  return db.prepare('SELECT * FROM images WHERE id = ?').get(Number(id)) || null;
}

export function markUsed(id) {
  if (!isImageGenReady()) return;
  db.prepare('UPDATE images SET used_count = used_count + 1, last_used = ? WHERE id = ?').run(Date.now(), Number(id));
}

export function getImageStats() {
  if (!isImageGenReady()) return { total: 0 };
  const total = db.prepare('SELECT COUNT(*) AS c FROM images').get().c;
  const sent = db.prepare('SELECT COUNT(*) AS c FROM images WHERE used_count > 0').get().c;
  return { total, sent, dbPath: path.join(root, 'images.db'), dir: genDir };
}
