/**
 * B 站养号。
 *
 * 背景：Lv2 的号发评论会被静默吞掉（接口 code=0，评论区看不到），
 * 但弹幕立即可见。所以她的表达走弹幕，经验靠每日任务慢慢攒。
 *
 * 经验账（Lv2 → Lv3 需要 1500）：
 *   登录 5 + 观看 5 + 分享 5 + 投币 10/个（每天最多 5 个）
 * 硬币每天登录补 1 个，所以现实速度是每天投 1 个币 ≈ 25 经验/天。
 * 这里不刷量、不突击，就按正常用户的节奏每天领。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const STATE_DIR = path.join(os.homedir(), '.bili-ai');
const GROWTH_FILE = path.join(STATE_DIR, 'growth.jsonl');

function csrfFrom(headers) {
  // buildHeaders 用的是小写 key（h.cookie），这里两种都要认
  const cookie = headers?.Cookie || headers?.cookie || '';
  const m = String(cookie).match(/bili_jct=([^;]+)/);
  return m ? m[1] : '';
}

function baseHeaders(headers) {
  return { ...headers, 'User-Agent': UA, 'Referer': 'https://www.bilibili.com/' };
}

async function post(url, body, headers) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...baseHeaders(headers),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(15000),
  });
  return res.json();
}

/** 发一条弹幕。progressMs 是它出现在视频第几毫秒。 */
export async function postDanmaku({ cid, bvid, aid, msg, headers, progressMs = 15000 }) {
  const text = String(msg || '').trim().slice(0, 100);
  if (!text) return { ok: false, code: -1, message: '空弹幕' };
  try {
    const r = await post(
      'https://api.bilibili.com/x/v2/dm/post',
      {
        type: 1,
        oid: cid,
        msg: text,
        bvid,
        progress: Math.max(0, Math.round(progressMs)),
        mode: 1,
        fontsize: 25,
        color: 16777215,
        pool: 0,
        plat: 1,
        csrf: csrfFrom(headers),
      },
      headers
    );
    return { ok: r.code === 0, code: r.code, message: r.message, dmid: r.data?.dmid };
  } catch (e) {
    return { ok: false, code: -1, message: e?.message || String(e) };
  }
}

/** 投币。select_like=1 会顺带点赞。 */
export async function giveCoin({ aid, headers, count = 1 }) {
  try {
    const r = await post(
      'https://api.bilibili.com/x/web-interface/coin/add',
      { aid, multiply: Math.min(2, Math.max(1, count)), select_like: 1, csrf: csrfFrom(headers) },
      headers
    );
    return { ok: r.code === 0, code: r.code, message: r.message };
  } catch (e) {
    return { ok: false, code: -1, message: e?.message || String(e) };
  }
}

/** 分享（会在动态里留一条，所以只在安全内容上用）。 */
export async function shareVideo({ aid, headers }) {
  try {
    const r = await post(
      'https://api.bilibili.com/x/web-interface/share/add',
      { aid, csrf: csrfFrom(headers) },
      headers
    );
    return { ok: r.code === 0, code: r.code, message: r.message };
  } catch (e) {
    return { ok: false, code: -1, message: e?.message || String(e) };
  }
}

/** 查账号当前状态：等级、经验、硬币、今日任务完成情况。 */
export async function checkGrowth(headers) {
  const H = baseHeaders(headers);
  try {
    const nav = await (await fetch('https://api.bilibili.com/x/web-interface/nav', {
      headers: H, signal: AbortSignal.timeout(15000),
    })).json();
    const rw = await (await fetch('https://api.bilibili.com/x/member/web/exp/reward', {
      headers: H, signal: AbortSignal.timeout(15000),
    })).json();

    const li = nav.data?.level_info || {};
    return {
      ok: nav.code === 0,
      level: li.current_level,
      exp: li.current_exp,
      nextExp: li.next_exp,
      coins: nav.data?.money,
      todayTasks: rw.data?.task_info || null,
    };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/** 够不够本钱投币（留 1 个保底，别把自己投空）。 */
export async function canAffordCoin(headers) {
  const g = await checkGrowth(headers);
  if (!g.ok) return { ok: false, coins: 0 };
  return { ok: Number(g.coins || 0) > 1, coins: g.coins };
}

/** 每天记一笔进度，方便看长势。 */
export function recordGrowth(rec) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const row = { at: new Date().toISOString(), ...rec };
    fs.appendFileSync(GROWTH_FILE, JSON.stringify(row) + '\n', 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

/** 读最近的成长记录。 */
export function recentGrowth(n = 10) {
  try {
    if (!fs.existsSync(GROWTH_FILE)) return [];
    const lines = fs.readFileSync(GROWTH_FILE, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-n).map((l) => {
      try { return JSON.parse(l); } catch (e) { return null; }
    }).filter(Boolean);
  } catch (e) {
    return [];
  }
}

/** 让她自己想说一句什么弹幕。短、随口、不像总结。 */
export async function draftDanmaku(brain, v, seen, { mood = '' } = {}) {
  const prompt =
    `你刚看完一个视频。\n\n` +
    `标题：${v.title}\nUP：${v.up}\n你刚才的感受：${mood || '（说不清）'}\n\n` +
    (seen ? `视频里的画面：\n${String(seen).slice(0, 800)}\n\n` : '') +
    `现在你想在屏幕上飘一句弹幕。\n\n` +
    `弹幕的样子：短、随口、像脑子里冒出来就发出去的，一般 5~12 个字。\n` +
    `可以是吐槽、可以是接梗、可以是一句感叹、可以是问一句。\n` +
    `不要总结视频内容，不要"这个视频告诉我们"，不要像评论区的长评。\n` +
    `不要用标点符号堆句子，最多一个逗号。\n\n` +
    `有几件事你从来不碰：政治、历史人物、时事新闻、宗教民族、地域和性别对立。\n` +
    `只聊画面和内容本身，不评价任何群体，不站队。\n\n` +
    `只输出那句话本身，不要引号，不要解释。`;

  try {
    const out = await brain.reply({
      key: '__danmaku__',
      userId: 'self',
      userName: '自己',
      text: prompt,
      images: [],
      situation: '你正看着视频，想飘一句弹幕',
      history: [],
      record: false,
    });
    const t = String(out?.text || '').trim().replace(/^["'「『]|["'」』]$/g, '').trim();
    if (!t || t.length > 30) return null;
    return t.slice(0, 24);
  } catch (e) {
    return null;
  }
}

export const __debug = { postDanmaku, giveCoin, shareVideo, checkGrowth, canAffordCoin, draftDanmaku, csrfFrom };
export default { postDanmaku, giveCoin, shareVideo, checkGrowth, canAffordCoin, draftDanmaku, recordGrowth, recentGrowth };
