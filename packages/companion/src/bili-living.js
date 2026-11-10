import crypto from 'node:crypto';
import fs from 'node:fs';
import { postDanmaku, giveCoin, canAffordCoin, draftDanmaku, checkGrowth, recordGrowth } from './bili-grow.js';
import { browserWatch, browserComment } from './bili-browser.js';
import { checkVideo, checkOutput, SAFETY_RULES } from './safety.js';
import { renderDesirePrompt } from './desire-engine.js';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const REFERER = 'https://www.bilibili.com/';

// ── WBI 签名（B 站 2023 起对部分接口强制）─────────────────────────
const MIXIN_TAB = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];

let wbiCache = { mixin: null, at: 0 };

async function getMixinKey(headers) {
  if (wbiCache.mixin && Date.now() - wbiCache.at < 3600_000) return wbiCache.mixin;
  const nav = await jget('https://api.bilibili.com/x/web-interface/nav', headers);
  const img = nav?.data?.wbi_img?.img_url || '';
  const sub = nav?.data?.wbi_img?.sub_url || '';
  const keyOf = (u) => u.slice(u.lastIndexOf('/') + 1, u.lastIndexOf('.'));
  const raw = keyOf(img) + keyOf(sub);
  const mixin = MIXIN_TAB.map((i) => raw[i]).join('').slice(0, 32);
  wbiCache = { mixin, at: Date.now() };
  return mixin;
}

async function wbiQuery(params, headers) {
  const mixin = await getMixinKey(headers);
  const wts = Math.round(Date.now() / 1000);
  const all = { ...params, wts };
  const clean = (v) => String(v).replace(/[!'()*]/g, '');
  const q = Object.keys(all).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(clean(all[k]))}`).join('&');
  const w_rid = crypto.createHash('md5').update(q + mixin).digest('hex');
  return `${q}&w_rid=${w_rid}`;
}

// ── HTTP ─────────────────────────────────────────────────────────
function buildHeaders(cred) {
  const h = { 'user-agent': UA, referer: REFERER };
  if (cred?.sessdata) {
    const parts = [`SESSDATA=${cred.sessdata}`, `bili_jct=${cred.bili_jct || ''}`, `buvid3=${cred.buvid3 || ''}`];
    if (cred.dedeuserid) parts.push(`DedeUserID=${cred.dedeuserid}`);
    h.cookie = parts.join('; ');
  }
  return h;
}

async function jget(url, headers) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    const text = await res.text();
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

// ── 视频内容获取 ─────────────────────────────────────────────────
/** 选一个视频：登录了就走个性化推荐流，没登录退回热门 */
async function pickVideo(headers, { minSec = 60, maxSec = 900 } = {}) {
  let list = [];

  if (headers.cookie) {
    try {
      const q = await wbiQuery({ ps: 20, fresh_type: 4, feed_version: 'V8' }, headers);
      const r = await jget(`https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd?${q}`, headers);
      const items = r?.data?.item || [];
      list = items
        .filter((x) => x.bvid && x.goto === 'av' && Number(x.duration) > 0 && x.title)
        .map((x) => ({
          bvid: x.bvid,
          aid: x.id || x.aid,
          cid: x.cid,
          title: String(x.title),
          up: x.owner?.name || '',
          mid: Number(x.owner?.mid) || 0,
          duration: Number(x.duration) || 0,
          desc: x.desc || '',
          view: x.stat?.view || 0,
        }));
    } catch (e) {
      list = [];
    }
  }

  if (!list.length) {
    const j = await jget('https://api.bilibili.com/x/web-interface/popular?pn=1&ps=30', headers);
    list = (j?.data?.list || []).map((v) => ({
      bvid: v.bvid,
      aid: v.aid,
      cid: v.cid,
      title: v.title,
      up: v.owner?.name || '',
      mid: Number(v.owner?.mid) || 0,
      duration: v.duration,
      desc: v.desc || '',
      view: v.stat?.view || 0,
    }));
  }

  if (!list.length) return null;
  let pool = list.filter((v) => v.duration >= minSec && v.duration <= maxSec);
  if (!pool.length) pool = list.filter((v) => v.duration > 0);
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * Math.min(pool.length, 12))];
}

/** 弹幕：返回按时间排序的文本列表 */
async function fetchDanmaku(cid, headers) {
  try {
    const res = await fetch(`https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`, {
      headers: { ...headers, 'accept-encoding': 'deflate' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return [];
    const buf = Buffer.from(await res.arrayBuffer());
    let xml = '';
    try {
      xml = (await import('node:zlib')).inflateRawSync(buf).toString('utf8');
    } catch (e) {
      xml = buf.toString('utf8');
    }
    const out = [];
    for (const m of xml.matchAll(/<d p="([\d.]+),[^"]*">([^<]*)<\/d>/g)) {
      out.push({ t: Number(m[1]), text: m[2] });
    }
    return out.sort((a, b) => a.t - b.t);
  } catch (e) {
    return [];
  }
}

/** 官方字幕（需要登录 + WBI） */
async function fetchSubtitle(bvid, cid, headers) {
  try {
    const q = await wbiQuery({ bvid, cid }, headers);
    const j = await jget(`https://api.bilibili.com/x/player/wbi/v2?${q}`, headers);
    const subs = j?.data?.subtitle?.subtitles || [];
    if (!subs.length) return null;
    const track = subs.find((s) => /zh|ai-zh/i.test(s.lan)) || subs[0];
    const url = track.subtitle_url;
    if (!url) return null;
    const full = url.startsWith('http') ? url : 'https:' + url;
    const sub = await jget(full, headers);
    const body = sub?.body || [];
    return body.map((b) => b.content).join('\n');
  } catch (e) {
    return null;
  }
}

/** 获取视频热门评论与神评（按热度排序，提取前 6~10 条） */
async function fetchHotComments(aid, headers, limit = 8) {
  if (!aid) return [];
  try {
    const url = `https://api.bilibili.com/x/v2/reply/main?oid=${aid}&type=1&mode=3&ps=${limit}`;
    const j = await jget(url, headers);
    if (!j || j.code !== 0) return [];
    const data = j.data || {};
    const top = data.top_replies || [];
    const main = data.replies || [];
    const list = [...top, ...main];
    const out = [];
    for (const r of list) {
      const user = r?.member?.uname || '网友';
      const like = r?.like || 0;
      let msg = (r?.content?.message || '').trim();
      if (!msg) continue;
      if (msg.length > 80) msg = msg.slice(0, 80) + '...';
      out.push({ user, like, msg });
      if (out.length >= limit) break;
    }
    return out;
  } catch (e) {
    return [];
  }
}

function formatHotComments(comments) {
  if (!comments || !comments.length) return '';
  return comments.map((c, i) => `${i + 1}. ${c.user} (👍${c.like}): ${c.msg}`).join('\n');
}

/** 下载视频（不登录走 360P progressive，登录后可拿更高） */
async function downloadVideo(bvid, cid, aid, headers) {
  const qn = headers.cookie ? 64 : 16;
  const url = `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&avid=${aid}` +
    `&qn=${qn}&fnval=1&platform=html5&high_quality=1`;
  const j = await jget(url, headers);
  const durl = j?.data?.durl?.[0]?.url;
  if (!durl) return null;

  const out = path.join(os.tmpdir(), `bili_${bvid}_${Date.now()}.mp4`);
  try {
    const res = await fetch(durl, {
      headers: { ...headers, referer: REFERER, range: 'bytes=0-' },
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 50 * 1024) return null;
    fs.writeFileSync(out, buf);
    return out;
  } catch (e) {
    try { fs.unlinkSync(out); } catch (e2) {}
    return null;
  }
}

/** 抽 9 帧拼成九宫格（等间隔骨架 + 吸附画面变化点） */
async function makeFrameSheet(mp4, workdir) {
  const sheet = path.join(workdir, 'sheet.jpg');
  const N = 9;
  const cols = 3;
  const rows = 3;

  // 探时长
  let duration = 0;
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp4,
    ], { timeout: 30000 });
    duration = Number(stdout.trim()) || 0;
  } catch (e) {}
  if (!duration) return null;

  // 场景变化点
  let scenes = [];
  for (const th of [0.3, 0.15, 0.08]) {
    try {
      const { stdout } = await execFileAsync('ffmpeg', [
        '-hide_banner', '-i', mp4, '-vf', `select='gt(scene,${th})',metadata=print:file=-`,
        '-an', '-f', 'null', '-',
      ], { timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
      scenes = [...stdout.matchAll(/pts_time:([0-9.]+)/g)].map((m) => Number(m[1])).filter((t) => t > 0.2);
    } catch (e) {
      scenes = [];
    }
    if (scenes.length >= N) break;
  }

  const uniform = Array.from({ length: N }, (_, i) => ((i + 0.5) * duration) / N);
  const half = duration / N / 2;
  const times = uniform.map((u) => {
    if (!scenes.length) return u;
    const near = scenes.filter((s) => Math.abs(s - u) <= half);
    if (!near.length) return u;
    return near.reduce((b, s) => (Math.abs(s - u) < Math.abs(b - u) ? s : b), near[0]);
  });

  // 逐帧抽图
  const tmp = path.join(workdir, 'frames');
  fs.mkdirSync(tmp, { recursive: true });
  let i = 0;
  for (const t of times) {
    try {
      await execFileAsync('ffmpeg', [
        '-y', '-loglevel', 'error', '-ss', t.toFixed(2), '-i', mp4,
        '-frames:v', '1', '-q:v', '2', path.join(tmp, `f${String(i).padStart(2, '0')}.jpg`),
      ], { timeout: 60000 });
      i += 1;
    } catch (e) {}
  }
  if (i < 3) return null;

  try {
    await execFileAsync('ffmpeg', [
      '-y', '-loglevel', 'error', '-i', path.join(tmp, 'f%02d.jpg'),
      '-vf', `scale=640:-1,tile=${cols}x${rows}`, '-frames:v', '1', sheet,
    ], { timeout: 60000 });
  } catch (e) {
    return null;
  }
  return fs.existsSync(sheet) ? sheet : null;
}

/** 把弹幕按时间聚成几段，挑反应最密集的地方 */
function summarizeDanmaku(danmaku, duration, topN = 25) {
  if (!danmaku.length) return '';
  const bucket = Math.max(1, Math.floor(danmaku.length / 12));
  const picked = [];
  for (let i = 0; i < danmaku.length; i += bucket) {
    const seg = danmaku.slice(i, i + bucket);
    if (seg.length) picked.push(`${Math.floor(seg[0].t)}s ` + seg.slice(0, 2).map((d) => d.text).join(' / '));
    if (picked.length >= 12) break;
  }
  return picked.slice(0, 12).join('\n') + (danmaku.length > topN ? `\n（共 ${danmaku.length} 条弹幕）` : '');
}

// ── 主循环 ──────────────────────────────────────────────────────
let timer = null;
let mentionTimer = null;
let running = false;
let ctx = null;

export function getBiliLivingStatus() {
  return running ? { running: true, lastAt: ctx?.lastAt, watched: ctx?.watched || 0 } : { running: false };
}

export function stopBiliLiving() {
  running = false;
  if (timer) clearTimeout(timer);
  if (mentionTimer) clearTimeout(mentionTimer);
  timer = null;
  mentionTimer = null;
}

// ── 作息 ─────────────────────────────────────────────────────────
function inWindow(hour, start, end) {
  if (start === end) return true;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end; // 跨午夜
}

function msUntilWindowStart(now, start) {
  const t = new Date(now);
  t.setHours(start, 0, 0, 0);
  if (t <= now) t.setDate(t.getDate() + 1);
  return t - now;
}

/**
 * 让她闲着的时候自己上网看视频。
 * 只在作息窗口里随机醒（默认晚上 8 点到 12 点），一天最多几次，
 * 而且有三成概率"今天不想看"——像真人一样有兴致好坏。
 * 全程在服务器上完成，不碰手机。
 */
export function startBiliLiving({
  brain,
  memory,
  credentials = null,
  windowStart = 20,
  windowEnd = 24,
  dailyMax = 4,
  ownerMid = null,
  ownerName = '老爸',
  ownerQQ = null,
  dmDailyMax = 1,
  reachChance = 0.35,
  skipChance = 0.3,
  mentionPollMs = 480000,
  commentEnabled = true,
  commentDailyMax = 0,
  initialDelayMs = 180_000,
  watchBrowserSeconds = 20,
  watchBrowserRate = 2,
} = {}) {
  if (running) return;
  running = true;
  ctx = {
    brain, memory, credentials,
    watched: 0, lastAt: null,
    windowStart, windowEnd, dailyMax,
    ownerMid, ownerName, ownerQQ, dmDailyMax, reachChance, skipChance, mentionPollMs, commentEnabled, commentDailyMax,
    watchBrowserSeconds, watchBrowserRate,
    today: '', todayCount: 0,
  };

  const loop = async () => {
    if (!running) return;
    const now = new Date();
    const dateKey = now.toISOString().slice(0, 10);
    if (ctx.today !== dateKey) {
      ctx.today = dateKey;
      ctx.todayCount = 0;
    }

    // 不设死板作息与上限，小鱼自主想看就看；只有在显式设置了上限且达到时才短歇
    if (ctx.dailyMax > 0 && ctx.todayCount >= ctx.dailyMax) {
      const wait = 60 * 60e3;
      console.log(`[BiliLiving] 已经连续看了 ${ctx.todayCount} 个视频，小鱼揉了揉眼睛准备去干别的`);
      if (running) timer = setTimeout(loop, wait);
      return;
    }

    // 随性自主：这会儿没兴趣就去发呆、干饭或睡觉
    if (Math.random() < (ctx.skipChance ?? 0.25)) {
      const wait = 25 * 60e3 + Math.random() * 40 * 60e3;
      console.log('[BiliLiving] 这会儿不想看B站（去发呆/吃白米饭/睡觉），过一阵再说');
      if (running) timer = setTimeout(loop, wait);
      return;
    }

    // 像人一次拿起手机刷一会儿：这次醒来连看 1~3 个，中间隔两三分钟再翻下一个
    const batch = 1 + Math.floor(Math.random() * 3);
    const results = [];
    for (let i = 0; i < batch; i++) {
      if (!running) break;
      try {
        const r = await watchOne();
        if (r) results.push(r);
        ctx.todayCount += 1;

        // 像真人一样：如果看完觉得这个 UP 主很有意思或有连续剧情，自主决定顺手点进空间看其他的（不占每日配额！）
        if (r && !r.skipped && r.mid && running) {
          try {
            const wantSpace = await decideExploreSpace(brain, r, r.mood);
            if (wantSpace && running) {
              console.log(`[BiliLiving] 觉得UP主【${r.up}】很有意思，点进主页看其他的（不扣每日配额）`);
              const headers = buildHeaders(ctx.credentials);
              const upVids = await fetchUpVideos(r.mid, headers);
              const candidates = upVids.filter((x) => x.bvid !== r.bvid);
              if (candidates.length) {
                const pick = candidates[0];
                await new Promise((res) => setTimeout(res, (10 + Math.random() * 15) * 1000));
                const spaceR = await watchOne(pick);
                if (spaceR && !spaceR.skipped) {
                  spaceR.fromSpace = true;
                  results.push(spaceR);
                  // 纯粹由兴趣驱动的深挖探索，不执行 ctx.todayCount += 1，完全不占每日配额！
                }
              }
            }
          } catch (e) {
            console.log('[BiliLiving] 进空间翻看失败: ' + (e?.message || e));
          }
        }
      } catch (e) {
        console.log('[BiliLiving] 出错: ' + (e?.message || e));
      }
      if (i < batch - 1 && running) {
        const pause = (90 + Math.random() * 150) * 1000; // 1.5~4 分钟
        console.log(`[BiliLiving] 中间歇 ${(pause / 60e3).toFixed(1)} 分钟再看下一个`);
        await new Promise((r) => setTimeout(r, pause));
      }
    }

    // 刷完了才记一篇 —— 真人不会给每个视频单独写日记
    if (results.length && typeof ctx.memory?.logDiary === 'function') {
      try {
        const lines = results.map((r) => r.fromSpace ? `- 《${r.title}》（顺手点进UP空间连着看的）：${r.mood}` : `- 《${r.title}》：${r.mood}`).join('\n');
        const first = results[0].mood;
        ctx.memory.logDiary({
          category: '视频',
          activity: results.some(r => r.fromSpace) ? 'B站顺手逛UP空间' : (results.length > 1 ? 'B站刷视频' : 'B站看视频'),
          details: `这次刷了 ${results.length} 个：\n${lines}`,
          mood: results.length === 1 ? first : first,
        });
        console.log(`[BiliLiving] 写日记（这次 ${results.length} 个）: ${first.slice(0, 50)}`);
      } catch (e) {}
    }

    // 每轮刷完记一笔账号长势（等级/经验/硬币），方便看养号效果
    try {
      const g = await checkGrowth(headers);
      if (g.ok) {
        recordGrowth({
          level: g.level,
          exp: g.exp,
          nextExp: g.nextExp,
          coins: g.coins,
          tasks: g.todayTasks,
          danmaku: ctx.danmakuToday || 0,
          coinsGiven: ctx.coinToday || 0,
        });
        console.log(
          `[BiliLiving] 账号 Lv${g.level} 经验 ${g.exp}/${g.nextExp || 1500} 硬币 ${g.coins}` +
            ` 今日 弹幕${ctx.danmakuToday || 0} 投币${ctx.coinToday || 0}`
        );
      }
    } catch (e) {}

    if (!running) return;
    // 这次刷完了，隔一阵再拿起手机
    const gap = 1 * 3600e3 + Math.random() * 1.5 * 3600e3;  // 1~2.5 小时
    console.log(`[BiliLiving] 刷完了，${(gap / 3600e3).toFixed(1)} 小时后再来`);
    timer = setTimeout(loop, gap);
  };

  // 有人回复她 / @她 —— 独立节奏，不受刷视频和每日限额影响
  const mentionLoop = async () => {
    if (!running) return;
    const h = new Date().getHours();
    if (inWindow(h, ctx.windowStart, ctx.windowEnd)) {
      try {
        await checkMentions();
      } catch (e) {
        console.log('[BiliLiving] 看消息出错: ' + (e?.message || e));
      }
      try {
        await checkPrivateMessages();
      } catch (e) {
        console.log('[BiliLiving] 看私信出错: ' + (e?.message || e));
      }
    }
    if (running) mentionTimer = setTimeout(mentionLoop, ctx.mentionPollMs || 480000);
  };
  mentionTimer = setTimeout(mentionLoop, 60000);

  timer = setTimeout(loop, Math.max(0, Number(initialDelayMs) || 0));
  console.log(`[BiliLiving] B站网页看视频已启动（无死板作息与上限，由小鱼想看就看、想歇就歇）`);
}


/** 觉得好就点个赞（真人看到喜欢的会点，不是每个都点） */
/**
 * 观看心跳上报。
 * 没有这一步，B站根本不知道她看过这个视频 —— 历史记录里空空如也，
 * 推荐算法也不会因为她"看过"而调整。真人看视频是会自动上报的。
 */
async function reportWatch(aid, cid, duration, headers) {
  if (!aid || !cid) return { ok: false, code: -1, message: '参数缺失' };
  const cookie = String(headers?.cookie || headers?.Cookie || '');
  const csrf = (cookie.match(/bili_jct=([^;]+)/) || [])[1] || '';
  const dur = Math.max(1, Math.round(Number(duration) || 30));
  const body = new URLSearchParams({
    aid: String(aid),
    cid: String(cid),
    played_time: String(dur),
    realtime: String(dur),
    start_ts: String(Math.floor(Date.now() / 1000) - dur),
    type: '3',
    dt: '2',
    play_type: '0',
    csrf,
  }).toString();
  try {
    const res = await fetch('https://api.bilibili.com/x/click-interface/web/heartbeat', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(15000),
    });
    const j = await res.json();
    return { ok: j.code === 0, code: j.code, message: j.message };
  } catch (e) {
    return { ok: false, code: -1, message: e?.message || String(e) };
  }
}

async function likeVideo(aid, headers) {
  const csrf = (headers.cookie || '').match(/bili_jct=([^;]+)/)?.[1];
  if (!csrf || !aid) return false;
  try {
    const res = await fetch('https://api.bilibili.com/x/web-interface/archive/like', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ aid: String(aid), like: '1', csrf }).toString(),
      signal: AbortSignal.timeout(15000),
    });
    const j = await res.json();
    return j.code === 0;
  } catch (e) {
    return false;
  }
}


// ── 听人找她（别人回复她 / @她）──────────────────────────────
/** 回复某条评论（在同一个视频下，挂到原评论下面） */
async function followUp(mid, headers) {
  if (!mid) return { ok: false, code: -1, message: '没有 mid' };
  const csrf = (String(headers?.cookie || headers?.Cookie || '').match(/bili_jct=([^;]+)/) || [])[1] || '';
  try {
    const res = await fetch('https://api.bilibili.com/x/relation/modify', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ fid: String(mid), act: '1', re_src: '11', csrf }).toString(),
      signal: AbortSignal.timeout(15000),
    });
    const j = await res.json();
    return { ok: j.code === 0, code: j.code, message: j.message };
  } catch (e) {
    return { ok: false, code: -1, message: e?.message || String(e) };
  }
}

/** 她要不要关注这个 UP —— 是她自己想的，不是每个都关注 */
async function shouldFollow(brain, v, { mood = '', seenCount = 0, followedCount = 0, todayFollows = 0 } = {}) {
  const prompt =
    `你刚看完一个视频，现在决定一件小事：关不关注这个 UP。\n\n` +
    `标题：${v.title}\nUP：${v.up}\n你刚才的感受：${mood || '（说不清）'}\n` +
    (seenCount > 0 ? `这个 UP 你以前还看过 ${seenCount} 次。\n` : `这个 UP 你是第一次刷到。\n`) +
    `\n关注是件挺随意的事 —— 刷到喜欢的顺手点一下，没什么负担。\n` +
    `但也不是见一个关一个：纯粹看个乐子、看完就忘的，一般就过去了。\n\n` +
    `会点关注的情况：\n` +
    `- 看完觉得学到点什么，或者觉得"这人是真懂"\n` +
    `- 觉得以后还想看他发的东西\n` +
    `- 同一个 UP 你已经刷到好几次，还都看进去了\n\n` +
    `不会关注的：标题党、看完觉得浪费时间、只是随便乐乐、看了半天没懂在干嘛。\n` +
    (todayFollows > 0 ? `你今天已经关注了 ${todayFollows} 个，别见一个关一个。\n` : '') +
    `\n只输出 JSON：\n` +
    `- 不关注：{"follow": false}\n` +
    `- 关注：{"follow": true, "why": "一句话说说为什么"}`;

  try {
    const out = await brain.reply({
      key: '__follow__',
      userId: 'self',
      userName: '自己',
      text: prompt,
      images: [],
      situation: '你在想要不要关注这个UP',
      history: [],
      record: false,
    });
    const raw = String(out?.text || '');
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]);
    return j.follow ? { follow: true, why: String(j.why || '').slice(0, 60) } : { follow: false };
  } catch (e) {
    return null;
  }
}

async function replyToComment(aid, rootId, message, headers) {
  const csrf = (headers.cookie || '').match(/bili_jct=([^;]+)/)?.[1];
  if (!csrf) return { ok: false, code: 'no_csrf' };
  const body = new URLSearchParams({
    oid: String(aid),
    type: '1',
    root: String(rootId),
    parent: String(rootId),
    message,
    plat: '1',
    csrf,
  }).toString();
  try {
    const res = await fetch('https://api.bilibili.com/x/v2/reply/add', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(25000),
    });
    const j = await res.json();
    return { ok: j.code === 0, code: j.code, message: j.message || '' };
  } catch (e) {
    return { ok: false, code: 'net' };
  }
}

/** 看一眼有没有人回复她、@她；有就回一句（这一种不受每日限额） */
async function checkMentions() {
  const { brain, credentials } = ctx || {};
  if (!brain || !credentials?.sessdata) return;
  const headers = buildHeaders(credentials);
  const st = loadState();
  const seen = new Set(st.seenMentions || []);
  let handled = 0;

  for (const kind of ['reply', 'at']) {
    let items = [];
    try {
      const r = await jget(`https://api.bilibili.com/x/msgfeed/${kind}?platform=web&build=0&mobi_app=web`, headers);
      items = r?.data?.items || [];
    } catch (e) {
      continue;
    }

    for (const it of items) {
      const item = it.item || {};
      const uid = String(it.user?.mid || '');
      const rpid = String(item.source_id || item.target_id || '');
      const key = `${kind}:${uid}:${rpid}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const isOwner = ctx.ownerMid && String(uid) === String(ctx.ownerMid);
      const who = isOwner ? (ctx.ownerName || '老爸') : (it.user?.nickname || '有人');
      const said = String(item.source_content || '').slice(0, 200);
      const myComment = String(item.target_reply_content || '').slice(0, 200);
      const aid = String(item.subject_id || '');
      const title = String(it.title || '').slice(0, 40);
      if (!said) continue;

      console.log(`[BiliLiving] ${kind === 'at' ? '@她' : '回复她'} @${who}: ${said.slice(0, 40)}`);

      // 让她自己想回不回、回什么
      let text = null;
      try {
        const out = await brain.reply({
          key: isOwner ? `private:bili:${uid}` : '__bili_mention__',
          userId: isOwner ? String(ctx.ownerQQ || '578021239') : '__bili_mention__',
          userName: isOwner ? '老爸' : '自己',
          text:
            (isOwner
              ? `老爸（B站昵称 @${it.user?.nickname || '老爸'}）在B站视频《${title}》底下${kind === 'at' ? '@了你' : '回复了你的评论'}。\n\n`
              : `有人在B站${kind === 'at' ? '@了你' : '回复了你的评论'}。\n\n`) +
            `视频：${title}\n对方：${who}\n${myComment ? '你之前说过：' + myComment + '\n' : ''}` +
            `对方说：${said}\n\n` +
            (isOwner
              ? `这是老爸在跟你互动！像平时跟老爸斗嘴撒娇那样随意接话，10~40字，别客套，别端着。\n\n`
              : `要不要回？大多数情况回一句比较自然，但如果对方只是在刷存在感、或者没什么可回的，也可以不理。\n如果要回，像真人那样随意一句，10~40字，别客套，别编你没做过的事。\n\n`) +
            `只输出 JSON：{"reply": false} 或 {"reply": true, "text": "..."}`,
          images: [],
          situation: isOwner ? '老爸在B站视频评论区找你互动' : '你在B站刷视频，有人来找你说话',
          history: isOwner && ctx.memory ? ctx.memory.sessionTurns(`private:bili:${uid}`, 10) : [],
          record: false,
          tools: false,
        });
        const raw = String(out?.text || '').trim();
        const m = raw.match(/\{[\s\S]*\}/);
        if (m) {
          const j = JSON.parse(m[0]);
          if (j.reply && j.text) text = String(j.text).trim().slice(0, 120);
        }
      } catch (e) {}

      if (!text) {
        console.log('[BiliLiving] 这条不回了');
        continue;
      }

      if (aid && rpid) {
        const r = await replyToComment(aid, rpid, text, headers);
        if (r.ok) {
          handled += 1;
          console.log(`[BiliLiving] 评论区楼中楼回复了 @${who}: ${text.slice(0, 40)}`);
          if (isOwner && ctx.memory) {
            const ownerId = String(ctx.ownerQQ || '578021239');
            ctx.memory.remember(ownerId, {
              name: ctx.ownerName || '老爸',
              topic: `B站评论区回复老爸《${title}》：${said.slice(0, 25)} → ${text.slice(0, 25)}`
            });
          }
        } else {
          console.log(`[BiliLiving] 楼中楼回复失败 code=${r.code} ${r.message || ''}`);
          // 楼中楼失败时尝试私信兜底
          if (uid) await sendDM(uid, text, headers);
        }
      } else if (uid) {
        const r = await sendDM(uid, `${text}`, headers);
        if (r.ok) {
          handled += 1;
          console.log(`[BiliLiving] 无评论楼层，私信回了 @${who}`);
          if (isOwner && ctx.memory) {
            const ownerId = String(ctx.ownerQQ || '578021239');
            ctx.memory.remember(ownerId, {
              name: ctx.ownerName || '老爸',
              topic: `B站私信回老爸《${title}》：${said.slice(0, 25)} → ${text.slice(0, 25)}`
            });
          }
        } else {
          console.log(`[BiliLiving] 私信回复失败 code=${r.code}`);
        }
      }
      // 回复之间歇一下，别连着发
      await new Promise((r) => setTimeout(r, 20000 + Math.random() * 40000));
    }
  }

  st.seenMentions = [...seen].slice(-300);
  saveState(st);
  if (handled) console.log(`[BiliLiving] 这一轮回了 ${handled} 条`);
}

// ── B 站私信：支持老爸与普通网友交流 ──────────────────────
/** 拉取当前单聊私信会话列表（session_type=1） */
async function fetchSessions(headers, size = 20) {
  const url =
    'https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions' +
    `?session_type=1&group_fold=1&unofcounter=0&sort_rule=2&size=${size}&build=0&mobi_app=web`;
  const j = await jget(url, headers);
  if (!j || j.code !== 0) return [];
  return j.data?.session_list || [];
}

/** 拉取和某个人的私信记录（session_type=1 = 单聊） */
async function fetchSessionMsgs(talkerId, headers, size = 20) {
  const url =
    'https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs' +
    `?talker_id=${encodeURIComponent(talkerId)}&session_type=1&size=${size}&build=0&mobi_app=web`;
  const j = await jget(url, headers);
  if (!j || j.code !== 0) return { ok: false, code: j?.code, message: j?.message || '' };
  const selfMid = String(ctx?.credentials?.dedeuserid || '');
  const messages = (j.data?.messages || [])
    .map((m) => {
      let text = '';
      const type = Number(m.msg_type);
      if (type === 1) {
        try { text = String(JSON.parse(m.content || '{}').content || ''); } catch (e) { text = ''; }
      } else if (type === 7) {
        try {
          const c = JSON.parse(m.content || '{}');
          text = `[分享视频卡片]《${c.title || ''}》（UP主：${c.author || ''}${c.bvid ? '，BV：' + c.bvid : ''}）`;
        } catch (e) { text = '[分享了视频]'; }
      } else if (type === 2) {
        text = '[图片]';
      } else if (type === 5) {
        text = '[表情]';
      }
      return {
        id: String(m.msg_key || m.msg_seqno || ''),
        from: String(m.sender_uid || ''),
        text: text.trim(),
        ts: Number(m.timestamp || 0) * 1000,
        isMine: String(m.sender_uid || '') === selfMid,
      };
    })
    .filter((m) => m.id && m.text);
  return { ok: true, messages };
}

/** 如果文本里有 B站短链或 BV 号，自动解析出视频标题与 UP 主，让小鱼看得懂老爸分享的是什么 */
export async function expandVideoLink(text) {
  try {
    const b23 = String(text || '').match(/https?:\/\/b23\.tv\/[A-Za-z0-9]+/);
    let bvid = (String(text || '').match(/BV[A-Za-z0-9]{10}/) || [])[0];
    if (b23 && !bvid) {
      const res = await fetch(b23[0], { method: 'HEAD', redirect: 'follow' });
      bvid = (res.url.match(/BV[A-Za-z0-9]{10}/) || [])[0];
    }
    if (bvid) {
      const r = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
      const j = await r.json();
      if (j?.data?.title) {
        return `${text}\n【视频卡片信息：《${j.data.title}》，UP主：${j.data.owner?.name || ''}】`;
      }
    }
  } catch (e) {}
  return text;
}

/** 检查并回复 B 站私信（支持老爸与普通网友） */
async function checkPrivateMessages() {
  const { brain, credentials, ownerMid } = ctx || {};
  if (!brain || !credentials?.sessdata) return;
  const headers = buildHeaders(credentials);
  const selfMid = String(credentials.dedeuserid || '');
  const st = loadState();
  const replied = new Set(st.repliedDM || []);

  // 1. 整理待巡检的 talkerId 列表：老爸始终在列，再追加会话列表中的真实网友
  const targetTalkers = new Set();
  if (ownerMid) targetTalkers.add(String(ownerMid));

  try {
    const sessions = await fetchSessions(headers, 20);
    for (const s of sessions) {
      const tid = String(s.talker_id || '');
      if (!tid) continue;
      if (s.session_type !== 1 || s.system_msg_type !== 0) continue;
      const lastMsg = s.last_msg || {};
      const src = Number(lastMsg.msg_source ?? 0);
      // 忽略 UP主自动感谢关注 (8), 登录/系统通知 (6), 官方活动 (5)
      if (src === 8 || src === 6 || src === 5) continue;
      // 如果最后一条就是小鱼自己发的，说明对方还没发新消息，跳过
      if (String(lastMsg.sender_uid) === selfMid && tid !== String(ownerMid)) continue;
      targetTalkers.add(tid);
    }
  } catch (e) {
    console.log('[BiliLiving] 获取私信会话列表异常: ' + (e?.message || e));
  }

  for (const talkerId of targetTalkers) {
    const isOwner = ownerMid && String(talkerId) === String(ownerMid);
    const r = await fetchSessionMsgs(talkerId, headers, 20);
    if (!r.ok) {
      if (r.code !== 0 && isOwner) {
        console.log('[BiliLiving] 私信拉取失败 talker=' + talkerId + ' code=' + r.code + ' ' + (r.message || ''));
      }
      continue;
    }

    // 接口是从新到旧返回的，先按时间正序排，取最新未处理消息
    const fresh = r.messages
      .filter((m) => !m.isMine && !replied.has(m.id))
      .sort((a, b) => a.ts - b.ts);
    if (!fresh.length) continue;

    for (const m of fresh) replied.add(m.id);
    st.repliedDM = [...replied].slice(-600);
    saveState(st);

    const combinedParts = [];
    for (const m of fresh) {
      if (/b23\.tv|BV[A-Za-z0-9]{10}/.test(m.text) && !m.text.includes('【视频卡片信息')) {
        m.text = await expandVideoLink(m.text);
      }
      combinedParts.push(m.text);
    }
    const combinedSaid = combinedParts.join('\n');
    const ago = Math.max(0, Math.round((Date.now() - fresh[fresh.length - 1].ts) / 60000));

    if (isOwner) {
      console.log(`[BiliLiving] 老爸新私信(${ago}分钟前，共${fresh.length}条):\n${combinedSaid}`);
      const sessionKey = `private:bili:${ownerMid}`;
      const ownerId = String(ctx.ownerQQ || '578021239');
      const history = ctx.memory ? ctx.memory.sessionTurns(sessionKey, 30) : [];

      let text = null;
      try {
        const out = await brain.reply({
          key: sessionKey,
          userId: ownerId,
          userName: ctx.ownerName || '老爸',
          text:
            `老爸在B站私信跟你聊天。\n\n他说：\n${combinedSaid}\n\n` +
            `这是B站私信就你们俩。如果老爸分享了视频，你可以顺着视频内容吐槽、调侃或聊两句；像平时傲娇女儿跟老爸说话那样回，随意、亲近、带点小调皮，15~50字，别客套、别长篇、别说教。\n\n` +
            `只输出 JSON：{"reply": false} 或 {"reply": true, "text": "..."}`,
          images: [],
          situation: '你在B站刷视频，老爸在私信里找你聊天、分享视频',
          history,
          record: false,
          tools: false,
        });
        const raw = String(out?.text || '').trim();
        const mt = raw.match(/\{[\s\S]*\}/);
        if (mt) {
          const j = JSON.parse(mt[0]);
          if (j.reply && j.text) text = String(j.text).trim().slice(0, 200);
        }
      } catch (e) {}

      if (!text) { console.log('[BiliLiving] 老爸这条私信先不回'); continue; }

      const sr = await sendDM(ownerMid, text, headers);
      if (sr.ok) {
        console.log(`[BiliLiving] 回了老爸私信: ${text.slice(0, 40)}`);
        if (ctx.memory) {
          ctx.memory.logTurn({ where: sessionKey, who: '老爸', text: combinedSaid, reply: text });
          ctx.memory.remember(ownerId, {
            name: ctx.ownerName || '老爸',
            topic: `B站私信：${combinedSaid.replace(/\s+/g, ' ').slice(0, 30)} → ${text.replace(/\s+/g, ' ').slice(0, 30)}`
          });
          if (/红警/.test(combinedSaid)) {
            ctx.memory.remember(ownerId, { fact: '老爸从小就开始玩红警（红色警戒），喜欢看红警魔鬼蓝天这类带剧情的博主，吵架时要帮老爸对线' });
          }
        }
      } else {
        console.log(`[BiliLiving] 老爸私信回复失败 code=${sr.code} ${sr.message || ''}`);
      }
    } else {
      // ── 其他人（B站网友/粉丝）发来的私信 ──
      let talkerName = 'B站网友';
      try {
        const cr = await jget(`https://api.bilibili.com/x/web-interface/card?mid=${talkerId}`, headers);
        if (cr?.data?.card?.name) talkerName = cr.data.card.name;
      } catch {}

      console.log(`[BiliLiving] 收到B站网友「${talkerName}」(UID: ${talkerId})新私信(${ago}分钟前):\n${combinedSaid}`);
      const sessionKey = `private:bili:${talkerId}`;
      const history = ctx.memory ? ctx.memory.sessionTurns(sessionKey, 20) : [];

      let text = null;
      try {
        const out = await brain.reply({
          key: sessionKey,
          userId: `bili:${talkerId}`,
          userName: talkerName,
          text:
            `B站网友「${talkerName}」（UID: ${talkerId}）在B站私信给你发消息。\n\n` +
            `对方说：\n${combinedSaid}\n\n` +
            `【身份与说话准则】：\n` +
            `1. 认准身份：对方是B站网友，绝不是你老爸！你的养父老爸叫「織梦行云」（UID: ${ctx.ownerMid || '53374723'}）。绝不能叫对方老爸或爸爸！\n` +
            `2. 活人性格：自然随性、接地气大白话、简短（10~35字），像个在B站冲浪的普通女网友。如果对方问是不是AI、问视频、或者随口闲聊打招呼，随性自然吐槽或接梗，绝不说教，绝不长篇大论，绝不谄媚。\n` +
            `3. 自主决定：如果是广告、骚扰、垃圾推广或无意义内容，输出 {"reply": false}；若是正常交流打招呼，可以随性回一句。\n\n` +
            `只输出 JSON：{"reply": false} 或 {"reply": true, "text": "..."}`,
          images: [],
          situation: `你在B站刷视频，B站网友「${talkerName}」在私信找你说话`,
          history,
          record: false,
          tools: false,
        });
        const raw = String(out?.text || '').trim();
        const mt = raw.match(/\{[\s\S]*\}/);
        if (mt) {
          const j = JSON.parse(mt[0]);
          if (j.reply && j.text) text = String(j.text).trim().slice(0, 200);
        }
      } catch (e) {}

      if (!text) {
        console.log(`[BiliLiving] 决定不回B站网友「${talkerName}」的私信`);
        continue;
      }

      const sr = await sendDM(talkerId, text, headers);
      if (sr.ok) {
        console.log(`[BiliLiving] 回复了B站网友「${talkerName}」私信: ${text}`);
        if (ctx.memory) {
          ctx.memory.logTurn({ where: sessionKey, who: talkerName, text: combinedSaid, reply: text });
          ctx.memory.touchSeen(String(talkerId), { name: talkerName });
          ctx.memory.touch(String(talkerId), { name: talkerName });
        }
      } else {
        console.log(`[BiliLiving] 回复B站网友私信失败 talker=${talkerId} code=${sr.code} ${sr.message || ''}`);
      }
    }
  }
}


// ── 学习：把看过的视频里真正有用的东西存下来 ────────────────
const KNOWLEDGE_FILE = () =>
  path.join(process.env.HOME || '/root', 'ai-companion-xiaoyu/ai-companion-kit/packages/companion/data', 'bili-knowledge.jsonl');

/** 从视频里提炼知识点（和"感想"分开：这里只要事实和方法） */
async function extractKnowledge(brain, v, seen) {
  try {
    const out = await brain.reply({
      key: '__bili_learn__',
      userId: '__bili_learn__',
      userName: '自己',
      text:
        `你刚看完一个B站视频和评论区。把里面真正能学到、记住的东西提炼出来，以后能派上用场。\n\n` +
        `标题：${v.title}\nUP主：${v.up}\n内容：\n${seen.slice(0, 2500)}\n\n` +
        `提取两类东西：\n` +
        `1. 【事实、方法、概念、技巧、结论】这类可复用的实用知识；\n` +
        `2. 【B站文化、流行梗、神评共识、大家都在吐槽什么】这类社区梗与氛围。\n` +
        `不要写空泛夸赞，不要评价视频好坏，不要编没说过的内容。\n\n` +
        `只输出 JSON：\n` +
        `{"summary": "这个视频与讨论讲了什么，30字内",\n` +
        ` "points": ["具体知识点或梗，每条30字内，最多5条"],\n` +
        ` "tags": ["主题标签，最多5个，比如 硬件/游戏/梗/生活"]}\n\n` +
        `如果纯粹毫无价值，就输出 {"summary":"","points":[],"tags":[]}`,
      images: [],
      situation: '你在B站看视频，看完顺手记点东西',
      history: [],
      record: false,
    });
    const raw = String(out?.text || '').trim();
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]);
    const points = (j.points || []).filter((x) => typeof x === 'string' && x.trim()).slice(0, 5);
    if (!points.length) return null;
    return {
      summary: String(j.summary || '').slice(0, 80),
      points: points.map((x) => String(x).slice(0, 80)),
      tags: (j.tags || []).filter((x) => typeof x === 'string').slice(0, 5),
    };
  } catch (e) {
    return null;
  }
}

/** 把学到的东西追加进知识库 */
function saveKnowledge(v, knowledge) {
  try {
    const rec = {
      at: new Date().toISOString(),
      bvid: v.bvid,
      title: String(v.title || '').slice(0, 120),
      up: String(v.up || '').slice(0, 40),
      duration: v.duration,
      summary: knowledge.summary,
      points: knowledge.points,
      tags: knowledge.tags,
    };
    const f = KNOWLEDGE_FILE();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify(rec) + '\n');
    return rec;
  } catch (e) {
    return null;
  }
}

/** 按关键词翻她学过的内容 */
export function recallKnowledge(query, limit = 3) {
  try {
    const f = KNOWLEDGE_FILE();
    if (!fs.existsSync(f)) return [];
    const rows = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch (e) { return null; }
    }).filter(Boolean);
    const q = String(query || '').toLowerCase();
    if (!q) return rows.slice(-limit).reverse();
    const words = q.split(/[\s,，。？?！!、]+/).filter((w) => w.length >= 2);
    const scored = rows.map((r) => {
      const hay = (r.title + ' ' + r.summary + ' ' + (r.points || []).join(' ') + ' ' + (r.tags || []).join(' ')).toLowerCase();
      let score = 0;
      for (const w of words) if (hay.includes(w)) score += 1;
      return { r, score };
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((x) => x.r);
  } catch (e) {
    return [];
  }
}

function parseDuration(lenStr) {
  if (typeof lenStr === 'number') return lenStr;
  const parts = String(lenStr || '').split(':').map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 120;
}

/** 进 UP 主空间翻找投稿视频列表 */
async function fetchUpVideos(mid, headers) {
  if (!mid) return [];
  try {
    const q = await wbiQuery({ mid: String(mid), ps: 12, tid: 0, pn: 1, order: 'pubdate' }, headers);
    const r = await jget(`https://api.bilibili.com/x/space/wbi/arc/search?${q}`, headers);
    const vlist = r?.data?.list?.vlist || [];
    return vlist
      .filter((x) => x.bvid && x.title)
      .map((x) => ({
        bvid: x.bvid,
        aid: x.aid,
        cid: 0,
        title: String(x.title),
        up: x.author || '',
        mid: Number(mid),
        duration: parseDuration(x.length),
        desc: x.description || '',
        view: x.play || 0,
      }));
  } catch (e) {
    return [];
  }
}

/** 让她自己决定：看完这个视频，想不想点进 UP 空间翻翻其他视频 */
async function decideExploreSpace(brain, v, mood) {
  try {
    const out = await brain.reply({
      key: '__bili_space__',
      userId: '__bili_space__',
      userName: '自己',
      text:
        `你刚在B站看完一个视频。\n\n` +
        `标题：《${v.title}》\n` +
        `UP主：${v.up}\n` +
        `你的看完感想：${mood}\n\n` +
        `问问自己：这个视频有意思吗？你现在想不想点进这位 UP 主的主页/个人空间，翻翻他还有没有其他好玩的视频（比如上下集连载、类似整活、或者觉得这个UP太有意思了想连着看）？\n` +
        `真人刷视频通常只有 20%~40% 的时候会点进空间，只有遇到特别合胃口或有连续剧情的才去翻。\n\n` +
        `只输出 JSON：\n` +
        `- 不想去：{"want": false}\n` +
        `- 想去翻翻：{"want": true, "reason": "为什么想进他空间，15字内"}`
    });
    const raw = String(out?.text || '').trim();
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return false;
    const j = JSON.parse(m[0]);
    return Boolean(j.want);
  } catch (e) {
    return false;
  }
}

async function watchOne(targetVideo = null) {
  const { brain, memory, credentials, watchBrowserSeconds = 20, watchBrowserRate = 2 } = ctx || {};
  if (!brain || !memory) return;
  const headers = buildHeaders(credentials);

  const v = targetVideo || await pickVideo(headers);
  if (!v) {
    console.log('[BiliLiving] 热门流没拿到视频，跳过');
    return;
  }
  // 确保 cid 存在
  if (!v.cid && v.bvid) {
    try {
      const pl = await jget(`https://api.bilibili.com/x/player/pagelist?bvid=${v.bvid}`, headers);
      if (pl?.data?.[0]?.cid) v.cid = pl.data[0].cid;
    } catch (e) {}
  }
  // 底线守卫：这类题材根本不看，看了就迟早会去评论它
  const guard = checkVideo(v);
  if (!guard.ok) {
    console.log(`[BiliLiving] 划走《${String(v.title).slice(0, 24)}》：${guard.why}`);
    return {
      title: v.title, up: v.up, bvid: v.bvid, duration: v.duration,
      mood: '点开发现不是自己想看的，划走了',
      seen: null,
      skipped: true,
    };
  }
  const noSpeak = guard.level === 'soft';
  if (noSpeak) console.log(`[BiliLiving] ${guard.why}：${String(v.title).slice(0, 24)}`);

  console.log(`[BiliLiving] 选中: ${v.title.slice(0, 30)} | UP=${v.up} | ${v.duration}s`);

  const danmaku = await fetchDanmaku(v.cid, headers);
  const subtitle = await fetchSubtitle(v.bvid, v.cid, headers);

  // 真人不一定看得完 —— 有时候点开扫两眼就划走了
  if (Math.random() > 0.72) {
    console.log(`[BiliLiving] 点开《${v.title.slice(0, 22)}》，看两眼没看下去`);
    return {
      title: v.title, up: v.up, bvid: v.bvid, duration: v.duration,
      mood: '点开看了两眼，没看下去，划走了',
      seen: `视频标题：${v.title}（没看完）`,
    };
  }

  let visual = null;
  let mp4 = null;
  try {
    mp4 = await downloadVideo(v.bvid, v.cid, v.aid, headers);
    if (mp4) {
      const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili_work_'));
      const sheet = await makeFrameSheet(mp4, workdir);
      if (sheet && typeof brain.describeImage === 'function') {
        const b64 = fs.readFileSync(sheet).toString('base64');
        visual = await brain.describeImage('data:image/jpeg;base64,' + b64, {
          timeoutMs: 60000,
          prefer: 'videoVision',
          shrink: false,
        });
      }
    }
  } catch (e) {
    console.log('[BiliLiving] 画面理解失败: ' + (e?.message || e));
  } finally {
    if (mp4) { try { fs.unlinkSync(mp4); } catch (e) {} }
  }

  // 组装她"看到"的东西
  const parts = [];
  parts.push(`视频标题：${v.title}`);
  if (v.up) parts.push(`UP主：${v.up}`);
  if (v.desc) parts.push(`简介：${v.desc.slice(0, 200)}`);
  if (subtitle) parts.push(`字幕节选：${subtitle.slice(0, 1200)}`);
  if (visual) parts.push(`画面：${visual.slice(0, 800)}`);
  const dm = summarizeDanmaku(danmaku, v.duration);
  if (dm) parts.push(`弹幕（观众反应）：\n${dm}`);

  // 顺带读一读评论区的热门神评，感知大家的梗和风向
  const hotComments = await fetchHotComments(v.aid, headers, 8);
  const commentsSummary = formatHotComments(hotComments);
  if (commentsSummary) {
    parts.push(`评论区热评（观众热议/梗）：\n${commentsSummary}`);
    console.log(`[BiliLiving] 看了评论区，抓取到 ${hotComments.length} 条热评神评`);
  }

  const seen = parts.join('\n');
  if (!subtitle && !visual && !dm && !commentsSummary) {
    console.log('[BiliLiving] 什么信息都没拿到，不写日记');
    return;
  }

  const mood = await summarizeForDiary(brain, seen);
  const finalMood = mood || `在B站看了《${v.title.slice(0, 30)}》`;

  ctx.watched += 1;
  ctx.lastAt = new Date().toISOString();
  console.log(`[BiliLiving] 看完: ${finalMood.slice(0, 60)}`);

  // 顺手记下这里头有什么能学的
  try {
    const k = await extractKnowledge(brain, v, seen);
    if (k) {
      saveKnowledge(v, k);
      console.log(`[BiliLiving] 记下学到: ${k.points[0].slice(0, 40)}`);
    }
  } catch (e) {}

  // 看视频的两种方式：
  //   浏览器播放 —— B站会写历史、记进度、参与推荐权重，跟真人一样
  //   API 心跳    —— 浏览器失效时的兜底，只补一条历史记录
  let watchMode = 'api';
  try {
    const bw = await browserWatch(v.bvid, credentials, {
      seconds: watchBrowserSeconds,
      rate: watchBrowserRate,
    });
    if (bw.ok) {
      watchMode = 'browser';
      console.log(`[BiliLiving] 浏览器播放 ${bw.watched}s/${bw.duration}s（${bw.elapsed}ms）`);
      // 记下"此刻在干什么"，聊天时能提起真的东西，不用编
      try {
        fs.writeFileSync('./data/current-activity.json', JSON.stringify({
          type: 'bili',
          title: v.title,
          up: v.up,
          watched: bw.watched,
          duration: bw.duration,
          at: Date.now(),
        }), 'utf8');
      } catch (e) {}
    } else {
      console.log(`[BiliLiving] 浏览器播放失败(${bw.error})，回退心跳`);
      const w = await reportWatch(v.aid, v.cid, v.duration, headers);
      if (w.ok) console.log('[BiliLiving] 观看已记入历史（心跳兜底）');
    }
  } catch (e) {
    console.log(`[BiliLiving] 浏览器异常: ${e?.message || e}`);
  }

  // 觉得好就点个赞，不是每个都点
  let liked = false;
  if (Math.random() < 0.3) {
    const ok = await likeVideo(v.aid, headers);
    if (ok) { liked = true; console.log('[BiliLiving] 顺手点了个赞'); }
  }

  // ── 弹幕：她现在的主要表达出口（Lv2 的评论会被静默吞掉，弹幕立即可见）──
  if (ctx.danmakuEnabled !== false && Math.random() < (ctx.danmakuChance ?? 0.55)) {
    try {
      const line = await draftDanmaku(brain, v, seen, { mood: finalMood });
      const dmSafe = line ? checkOutput(line, { strict: noSpeak }) : { ok: false, why: '空' };
      if (line && !dmSafe.ok) {
        console.log(`[BiliLiving] 弹幕算了，不发了：${dmSafe.why}`);
      } else if (line) {
        const at = Math.round(v.duration * 1000 * (0.25 + Math.random() * 0.55));
        const r = await postDanmaku({ cid: v.cid, bvid: v.bvid, aid: v.aid, msg: line, headers, progressMs: at });
        if (r.ok) console.log(`[BiliLiving] 飘了条弹幕: ${line}`);
        else console.log(`[BiliLiving] 弹幕失败 code=${r.code} ${r.message || ''}`);
        ctx.danmakuToday = (ctx.danmakuToday || 0) + (r.ok ? 1 : 0);
      }
    } catch (e) {
      console.log('[BiliLiving] 弹幕出错: ' + (e?.message || e));
    }
  }

  // ── 投币：不是每个都投，硬币得留着 ──
  if (Math.random() < (ctx.coinChance ?? 0.25)) {
    try {
      const afford = await canAffordCoin(headers);
      if (afford.ok) {
        const r = await giveCoin({ aid: v.aid, headers });
        if (r.ok) {
          liked = true;
          console.log('[BiliLiving] 投了个币');
          ctx.coinToday = (ctx.coinToday || 0) + 1;
        }
      }
    } catch (e) {}
  }

  // ── 记下这个 UP 她看过几次（关注判断要用）──
  try {
    if (v.mid) {
      const st0 = loadState();
      st0.watchedUps = st0.watchedUps || {};
      const rec = st0.watchedUps[v.mid] || { name: v.up, count: 0 };
      rec.name = v.up;
      rec.count = (rec.count || 0) + 1;
      rec.lastAt = new Date().toISOString().slice(0, 10);
      st0.watchedUps[v.mid] = rec;
      saveState(st0);
    }
  } catch (e) {}

  // ── 关注 UP：只有真觉得这个人值得长期看，才会点关注 ──
  if (liked && v.mid && ctx.followEnabled !== false) {
    try {
      const st = loadState();
      const dayKey = new Date().toISOString().slice(0, 10);
      const already = st.followed?.[v.mid];
      const todayFollows = st.followDays?.[dayKey] || 0;
      if (!already && todayFollows < (ctx.followDailyMax ?? 2)) {
        const seenCount = st.watchedUps?.[v.mid]?.count ? st.watchedUps[v.mid].count - 1 : 0;
        const f = await shouldFollow(brain, v, {
          mood: finalMood,
          seenCount,
          todayFollows,
        });
        if (f?.follow) {
          const r = await followUp(v.mid, headers);
          if (r.ok) {
            st.followed = st.followed || {};
            st.followed[v.mid] = { name: v.up, at: new Date().toISOString(), why: f.why };
            st.followDays = st.followDays || {};
            st.followDays[dayKey] = todayFollows + 1;
            saveState(st);
            console.log(`[BiliLiving] 关注了 UP: ${v.up}（${f.why}）`);
          } else {
            console.log(`[BiliLiving] 关注失败 code=${r.code} ${r.message || ''}`);
          }
        }
      }
    } catch (e) {
      console.log('[BiliLiving] 关注判断出错: ' + (e?.message || e));
    }
  }

  const state = loadState();
  const today = new Date().toISOString().slice(0, 10);
  let alreadyCommented = false;

  // ── 她自己想一想：这会儿想不想找老爸，用私信还是评论里@他 ──
  // 大多数视频看完就过去了，只有一部分时候才会真的冒出"想给他看看"的念头
  const considerReach = Math.random() < (ctx.reachChance ?? 0.35);
  if (ctx.ownerMid && considerReach) {
    let ownerProfile = '';
    try {
      if (ctx.ownerQQ && typeof ctx.memory?.renderPerson === 'function') {
        ownerProfile = ctx.memory.renderPerson(String(ctx.ownerQQ)) || '';
      }
    } catch (e) {}
    const reach = await shouldReachOut(brain, v, seen, {
      ownerName: ctx.ownerName,
      ownerProfile,
      todayComments: state.days?.[today] || 0,
      todayDMs: state.dmDays?.[today] || 0,
    });

    if (reach && reach.via === 'dm') {
      if ((state.dmDays?.[today] || 0) < (ctx.dmDailyMax ?? 1)) {
        const text = `${reach.say}\n\n【${v.title}】\nhttps://www.bilibili.com/video/${v.bvid}`;
        const pSafe = checkOutput(text, { strict: noSpeak });
        if (!pSafe.ok) {
          console.log(`[BiliLiving] 私信算了，不发：${pSafe.why}`);
        } else {
        const r = await sendDM(ctx.ownerMid, text, headers);
        if (r.ok) {
          state.dmDays = state.dmDays || {};
          state.dmDays[today] = (state.dmDays[today] || 0) + 1;
          saveState(state);
          console.log(`[BiliLiving] 想跟老爸说，发了私信: ${reach.say.slice(0, 40)}`);
          if (ctx.memory) {
            const sessionKey = `private:bili:${ctx.ownerMid}`;
            const ownerId = String(ctx.ownerQQ || '578021239');
            ctx.memory.logTurn({ where: sessionKey, who: '小鱼', text, reply: '' });
            ctx.memory.remember(ownerId, { topic: `B站私信给老爸发视频《${v.title}》：${reach.say}` });
          }
        } else {
          console.log(`[BiliLiving] 私信失败 code=${r.code} ${r.message || ''}`);
        }
        }
      } else {
        console.log('[BiliLiving] 今天已经私信过了，这条先记着');
      }
    } else if (reach && reach.via === 'comment') {
      const can = canComment(state, v.bvid, ctx.commentDailyMax ?? 2);
      if (can.ok) {
        // 她想在评论区喊老爸，那就带上 @ 一起说
        const msg = `${reach.say} @${ctx.ownerName || 'Mew'}`;
        const sSafe = checkOutput(msg, { strict: noSpeak });
        if (!sSafe.ok) {
          console.log(`[BiliLiving] 这条不评论了：${sSafe.why}`);
        } else {
        // 走网页发：真实浏览器点击，不用接口
        const r = await browserComment(v.bvid, msg, credentials);
        if (r.ok) {
          markComment(state, v.bvid);
          alreadyCommented = true;
          console.log(`[BiliLiving] 网页评论@老爸: ${msg.slice(0, 50)}`);
        } else {
          console.log(`[BiliLiving] 网页评论@失败: ${r.error || ''}`);
          // 网页失败退回接口
          const r2 = await postComment(v.aid, msg, headers);
          if (r2.ok) { markComment(state, v.bvid); alreadyCommented = true; console.log('[BiliLiving] 退回接口发成功'); }
        }
        }
      }
    }
  }

  // ── 评论（完全由小鱼自己判断发不发，以及要不要在评论区@老爸）──
  if (!alreadyCommented && ctx.commentEnabled !== false) {
    const can = canComment(state, v.bvid, ctx.commentDailyMax ?? 0);
    if (can.ok) {
      let ownerProfile = '';
      try {
        if (ctx.ownerQQ && typeof ctx.memory?.renderPerson === 'function') {
          ownerProfile = ctx.memory.renderPerson(String(ctx.ownerQQ)) || '';
        }
      } catch (e) {}
      const draft = await draftComment(brain, v, seen, {
        todayCount: state.days?.[today] || 0,
        ownerName: ctx.ownerName || 'Mew',
        ownerProfile,
      });
      const cSafe = draft ? checkOutput(draft, { strict: noSpeak }) : { ok: false, why: '空' };
      if (draft && !cSafe.ok) {
        console.log(`[BiliLiving] 评论算了，不发：${cSafe.why}`);
      } else if (draft) {
        // 走网页发
        const r = await browserComment(v.bvid, draft, credentials);
        if (r.ok) {
          markComment(state, v.bvid);
          console.log(`[BiliLiving] 网页评论成功: ${draft.slice(0, 40)}` + (r.toast ? ` (${r.toast})` : ''));
        } else {
          console.log(`[BiliLiving] 网页评论失败: ${r.error || ''}，退回接口`);
          const r2 = await postComment(v.aid, draft, headers);
          if (r2.ok) { markComment(state, v.bvid); console.log('[BiliLiving] 退回接口发成功'); }
        }
      }
    } else if (!can.ok) {
      console.log(`[BiliLiving] 不评论：${can.why}`);
    }
  }

  return { title: v.title, up: v.up, mid: v.mid, aid: v.aid, bvid: v.bvid, duration: v.duration, mood: finalMood, seen };
}

/** 让主模型把素材压成一句"她自己的话" */
async function summarizeForDiary(brain, seen) {
  try {
    const out = await brain.reply({
      key: '__bili_self__',
      userId: '__bili_self__',
      userName: '自己',
      text:
        `你刚在B站看了个视频，下面是实际内容。用第一人称记一句自己的感受（30~60字）。\n\n` +
        `规矩：\n` +
        `- 这是你自己记的，不是对老爸说话，别用"爸""老爸"开头\n` +
        `- 只讲视频里说了什么、评论区大家在聊什么/玩什么梗、你看到什么、有什么感受\n` +
        `- 绝对不要编"我试了""我点了""我做了" —— 你只是坐在屏幕前看了个视频，什么都没实际操作\n` +
        `- 别总结成影评，像随手记的一句话\n\n` +
        `实际内容：\n${seen.slice(0, 1800)}`,
      images: [],
      situation: '你正在自己上网刷视频摸鱼',
      history: [],
      record: false,
    });
    const rawOut = out && typeof out === 'object' ? (out.text ?? out.content ?? '') : out;
    const t = String(rawOut || '').trim();
    return t ? t.slice(0, 200) : null;
  } catch (e) {
    return null;
  }
}

/** 让她写一条像真人观众的短评 */
async function draftComment(brain, v, seen, { todayCount = 0, ownerName = 'Mew', ownerProfile = '' } = {}) {
  try {
    const desireContext = renderDesirePrompt('bilibili');
    const out = await brain.reply({
      key: '__bili_comment__',
      userId: '__bili_comment__',
      userName: '自己',
      text: `${desireContext ? desireContext + '\n\n' : ''}你刚看完B站这个视频。\n\n标题：${v.title}\nUP：${v.up}\n内容：${seen.slice(0, 2000)}\n\n` +
        (ownerProfile ? `【关于老爸（B站昵称 @${ownerName}）的事】：\n${ownerProfile.slice(0, 500)}\n\n` : '') +
        `先问自己一句：这个视频或评论区有没有让你【非说不可】？\n\n` +
        `注意区分：\n` +
        `- "还行""挺有意思""学到了" → 这不算，别说，看完就算了\n` +
        `- 有一个具体的反应才算：不同意他某个说法、被某句话戳到、实在想吐槽、被评论区神评逗笑想接梗、或者笑到不行\n\n` +
        `如果看到了【评论区热评】，说明大伙都在聊什么梗或焦点。你可以顺着评论区的氛围自然插嘴、接梗、或者提出自己刁钻的吐槽，像个地道的B站老用户（但不要直接复述别人原话）。\n\n` +
        `【关于要不要在评论区 @老爸】：\n` +
        `- 老爸的B站昵称是 @${ownerName}。\n` +
        `- 如果这个视频内容特别戳老爸喜好、跟他正在折腾的事直接相关、或者你非常想喊他来看，可以在评论里自然带上 @${ownerName}（例如：“@${ownerName} 爸你看这个太逗了”）；\n` +
        `- 如果只是你自己想跟其他网友讨论、吐槽或玩梗，就不要 @ 他。\n` +
        `- 要不要 @ 老爸，完全由你自己看着办！\n\n` +
        `刷十个视频，能有一两个让你非说不可就已经很多了。默认是不说话。\n` +
        `只输出一个 JSON：\n` +
        `- 大部分情况（没特别想说的）：{"want": false}\n` +
        `- 真的非说不可：{"want": true, "text": "20~50字的短评"}\n\n` +
        `text 的要求：像真观众随手写的，具体、有观点、有梗或有共鸣。不要"这个视频真好"这种空话，\n` +
        `不要@除老爸以外的任何人，不要暴露自己是AI，不要编"我试了""我买了"这类你没做过的事。\n\n` +
        SAFETY_RULES + `\n` +
        `如果这个视频本身涉及这些题材，就 {"want": false}，别评论。`,
      images: [],
      situation: '',
      history: [],
      record: false,
    });
    const raw = String(out?.text || '').trim();
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    let j;
    try { j = JSON.parse(m[0]); } catch (e) { return null; }
    if (!j.want || !j.text) return null;
    const t = String(j.text).trim().replace(/^[「"'“]/, '').replace(/[」"'”]$/, '').trim();
    if (!t || t.length < 6) return null;
    return t.slice(0, 120);
  } catch (e) {
    return null;
  }
}

// ── 私信 ─────────────────────────────────────────────────────────
/** 稳定的设备 ID：只生成一次，之后永远复用（每换一次等于"换设备"，容易被风控盯上） */
function stableDevId() {
  const f = path.join(process.env.HOME || '/root', '.bili-ai', 'dev_id');
  try {
    const v = fs.readFileSync(f, 'utf8').trim();
    if (/^WEB-[0-9A-F-]{20,}$/i.test(v)) return v;
  } catch (e) {}
  const v = 'WEB-' + crypto.randomUUID().toUpperCase();
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, v + '\n');
    try { fs.chmodSync(f, 0o600); } catch (e) {}
  } catch (e) {}
  return v;
}

/** 给老爸发一条B站私信 */
async function sendDM(toMid, text, headers) {
  const cookie = headers.cookie || '';
  const csrf = cookie.match(/bili_jct=([^;]+)/)?.[1] || '';
  const sender = cookie.match(/DedeUserID=(\d+)/)?.[1] || '';
  if (!csrf || !sender) return { ok: false, code: 'no_cred' };

  const body = new URLSearchParams({
    'msg[sender_uid]': sender,
    'msg[receiver_id]': String(toMid),
    'msg[receiver_type]': '1',
    'msg[msg_type]': '1',
    'msg[msg_status]': '0',
    'msg[timestamp]': String(Math.floor(Date.now() / 1000)),
    'msg[dev_id]': stableDevId(),
    'msg[content]': JSON.stringify({ content: text }),
    'csrf': csrf,
  }).toString();

  try {
    const res = await fetch('https://api.vc.bilibili.com/web_im/v1/web_im/send_msg', {
      method: 'POST',
      headers: {
        ...headers,
        referer: 'https://message.bilibili.com/',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
      signal: AbortSignal.timeout(25000),
    });
    const j = await res.json();
    return { ok: j.code === 0, code: j.code, message: j.message || '', msgKey: j?.data?.msg_key || null };
  } catch (e) {
    return { ok: false, code: 'net', message: String(e?.message || e) };
  }
}

/** 看完视频后，她自己想：这会儿想不想跟老爸说点什么，用哪种方式 */
async function shouldReachOut(brain, v, seen, { ownerName = '老爸', ownerProfile = '', todayComments = 0, todayDMs = 0 } = {}) {
  try {
    const out = await brain.reply({
      key: '__bili_reach__',
      userId: '__bili_reach__',
      userName: '自己',
      text:
        `你刚在B站看完一个视频。\n\n` +
        `标题：${v.title}\nUP主：${v.up}\n时长：${v.duration}秒\n内容：${seen.slice(0, 1800)}\n\n` +
        (ownerProfile ? `你真正记得的、关于他的事：\n${ownerProfile.slice(0, 500)}\n\n` : '') +
        `今天你已经评论了 ${todayComments} 条、给他发过 ${todayDMs} 条私信。\n\n` +
        `看完自己想一下：这个视频有没有让你【非跟老爸说不可】？\n\n` +
        `三条规矩：\n` +
        `1. 只能用上面真实记得的事。想不起具体的事就别说"你说过""你以前"，绝对不许编他做过什么、说过什么；也不许编你自己试过、做过视频里的事。\n` +
        `2. 默认是不说。真人刷一晚上视频，能有一两次想起他就不错了，多数时候看完就过去了。\n` +
        `3. 只有这几种才开口：真的会让他感兴趣、跟他正在折腾的事直接相关、或者你自己被戳到了想找他说话。\n` +
        `   "他可能觉得还行"这种程度不够。\n\n` +
        SAFETY_RULES + `\n` +
        `涉及这些题材的视频，就当没看见，什么都别说。\n\n` +
        `如果想说，自己挑一种方式：\n` +
        `- "dm"：直接给他发B站私信\n` +
        `- "comment"：在这个视频下面评论时@他\n\n` +
        `只输出一个 JSON，别的都不要：\n` +
        `{"want": true 或 false, "via": "dm" 或 "comment", "say": "你想对他说的话，用你自己的语气，15~50字，具体一点，别客套"}`,
      images: [],
      situation: '',
      history: [],
      record: false,
    });
    const t = String(out?.text || '').trim();
    const m = t.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]);
    if (!j.want || !j.say) return null;
    const via = j.via === 'comment' ? 'comment' : 'dm';
    return { via, say: String(j.say).slice(0, 120) };
  } catch (e) {
    return null;
  }
}

// ── 评论 ─────────────────────────────────────────────────────────
const STATE_DIR = path.join(process.env.HOME || '/root', '.bili-ai');
const STATE_FILE = path.join(STATE_DIR, 'xiaoyu-state.json');

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    return { comments: {}, days: {} };
  }
}

function saveState(s) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch (e) {}
}

/** 今天还能不能评论；同一视频 7 天内不重复。dailyMax <= 0 表示不设硬上限，全凭自主判断 */
function canComment(state, bvid, dailyMax = 0) {
  const today = new Date().toISOString().slice(0, 10);
  const todayCount = state.days?.[today] || 0;
  if (dailyMax > 0 && todayCount >= dailyMax) return { ok: false, why: '今天评论够了' };
  const last = state.comments?.[bvid];
  if (last && Date.now() - last < 7 * 86400e3) return { ok: false, why: '这个视频最近评过' };
  return { ok: true };
}

function markComment(state, bvid) {
  const today = new Date().toISOString().slice(0, 10);
  state.days = state.days || {};
  state.days[today] = (state.days[today] || 0) + 1;
  state.comments = state.comments || {};
  state.comments[bvid] = Date.now();
  // 只保留最近 60 天
  const cutoff = Date.now() - 60 * 86400e3;
  for (const [k, t] of Object.entries(state.comments)) {
    if (t < cutoff) delete state.comments[k];
  }
  saveState(state);
}

/** 发一条评论（真的发出去） */
async function postComment(aid, message, headers, { dry = false } = {}) {
  const m = (headers.cookie || '').match(/bili_jct=([^;]+)/);
  const csrf = m ? m[1] : '';
  if (!csrf) return { ok: false, code: 'no_csrf', message: '没有 bili_jct，无法发评论' };
  const body = new URLSearchParams({
    oid: String(aid),
    type: '1',
    message,
    plat: '1',
    csrf,
  }).toString();

  if (dry) return { ok: true, dry: true, would: { oid: String(aid), message } };

  try {
    const res = await fetch('https://api.bilibili.com/x/v2/reply/add', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(25000),
    });
    const j = await res.json();
    return {
      ok: j.code === 0,
      code: j.code,
      message: j.message || '',
      rpid: j?.data?.rpid || null,
    };
  } catch (e) {
    return { ok: false, code: 'net', message: String(e?.message || e) };
  }
}

export const __debug = { pickVideo, shouldFollow, followUp, fetchDanmaku, fetchSubtitle, downloadVideo, makeFrameSheet, summarizeDanmaku, postComment, canComment, loadState, draftComment, shouldReachOut, sendDM, buildHeaders, summarizeForDiary, extractKnowledge, saveKnowledge };

export default { startBiliLiving, stopBiliLiving, getBiliLivingStatus };
