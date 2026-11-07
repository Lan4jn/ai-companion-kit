/**
 * 小鱼自主互联网冲浪与吃瓜系统 (Web Living)
 * ─────────────────────────────────────────────────────────────
 * 1. 定期（每隔 60~120 分钟）或按需抓取全网实时热搜（微博热搜、B站热搜、百度热榜）。
 * 2. 经过严格的安全与去敏过滤（过滤时政、涉策、灾难、事故等非生活类话题）。
 * 3. 由小鱼根据自身爱好（数码、游戏、抽象日常、沙雕八卦、二次元）自决挑选最想吃瓜的话题。
 * 4. 真实调用搜索引擎搜索前因后果与网友辣评，生成真实的闺女/老群友内心吐槽与见闻。
 * 5. 沉淀至小鱼生活日记（diary.jsonl）与历史档案中，作为随时随地的网民见识与谈资。
 */

import fs from 'node:fs';
import path from 'node:path';
import { executeSearchTool } from './search-tools.js';
import { checkInput, checkOutput } from './safety.js';
import { renderDesirePrompt } from './desire-engine.js';

let activeBrain = null;
let activeMemory = null;
let timer = null;

// 过滤掉时政、外交、灾难、逝世、纪律通报与纯商业广告
const FILTER_PATTERNS = [
  /治党|从严|外长|省委|市委|总书记|总理|部长|外交部|会谈|通话|代表团|大使馆|政协|人大|全会|常委/,
  /火化|悼念|逝世|殉职|遗体|坠机|遇难|事故|灾害|地震|火灾|爆炸|伤亡|惨案|身亡|死刑|命案/,
  /拘留|逮捕|通报|开除党籍|立案审查|违纪|受贿|贪腐|反腐/,
  /大盘|A股|上证|深证|涨停|跌停/,
  /优惠券|专享|大促|双十一|领券/
];

let state = {
  isRunning: false,
  lastTopic: null,
  lastAction: '刚在网上看热搜摸鱼',
  history: [],
  summary: '',
  updatedAt: 0,
};

function getHistoryFile(dataDir) {
  return path.join(dataDir, 'web-surfing-history.json');
}

function getKnowledgeFile(dataDir) {
  return path.join(dataDir, 'web-knowledge.jsonl');
}

/** 读回她学到的东西 */
export function loadKnowledge(dataDir, limit = 200) {
  try {
    const file = getKnowledgeFile(dataDir);
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return lines
      .slice(-limit)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** 记住一条真学到的东西 */
export function rememberKnowledge(dataDir, item) {
  try {
    fs.appendFileSync(getKnowledgeFile(dataDir), JSON.stringify(item) + '\n', 'utf8');
  } catch {}
}

/**
 * 给聊天注入她最近学到的见识。
 * 只给事实，不给口吻模板 —— 用不用、怎么用由她自己判断。
 */
export function renderWebKnowledge(dataDir, limit = 8) {
  const list = loadKnowledge(dataDir, 120);
  if (!list.length) return '';
  const lines = [];
  for (const item of list.slice(-limit)) {
    for (const fact of (item.learned || []).slice(0, 2)) {
      if (fact && fact.length > 6) lines.push(`- ${fact}`);
    }
  }
  if (!lines.length) return '';
  return `【你最近自己上网搞明白的事】（聊到相关话题时可以自然带上，记不清就别硬说）\n${lines.slice(-14).join('\n')}`;
}

function loadHistory(dataDir) {
  try {
    const f = getHistoryFile(dataDir);
    if (fs.existsSync(f)) {
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    }
  } catch {}
  return [];
}

function saveHistory(dataDir, list) {
  try {
    const f = getHistoryFile(dataDir);
    fs.writeFileSync(f, JSON.stringify(list.slice(-100), null, 2), 'utf8');
  } catch (e) {
    console.warn('[WebLiving] 历史保存失败:', e?.message || e);
  }
}

/**
 * 抓取多平台实时热榜并去重过滤
 */
export async function fetchTrendingTopics(dataDir = '') {
  const all = [];

  // 1. 微博热搜 (社交娱乐、沙雕日常、生活吐槽)
  try {
    const res = await fetch('https://weibo.com/ajax/side/hotSearch', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://weibo.com'
      },
      signal: AbortSignal.timeout(6000)
    });
    const d = await res.json();
    (d?.data?.realtime || []).forEach((x) => {
      const w = x.word || x.note;
      if (w && !x.is_ad) all.push({ source: '微博', title: String(w).trim() });
    });
  } catch (e) {
    console.log('[WebLiving] 微博热搜抓取失败:', e.message);
  }

  // 2. B站热搜 (数码、单机网游、二次元、抽象玩梗)
  try {
    const res = await fetch('https://api.bilibili.com/x/web-interface/wbi/search/square?limit=25', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      signal: AbortSignal.timeout(6000)
    });
    const d = await res.json();
    (d?.data?.trending?.list || []).forEach((x) => {
      if (x.keyword) all.push({ source: 'B站', title: String(x.keyword).trim() });
    });
  } catch (e) {
    console.log('[WebLiving] B站热搜抓取失败:', e.message);
  }

  // 3. 百度热搜 (社会新知、科技新品)
  try {
    const res = await fetch('https://top.baidu.com/api/board?platform=wise&tab=realtime', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(6000)
    });
    const d = await res.json();
    (d?.data?.cards?.[0]?.content?.[0]?.content || []).forEach((x) => {
      if (x.word && !x.isTop) all.push({ source: '百度', title: String(x.word).trim() });
    });
  } catch (e) {
    console.log('[WebLiving] 百度热搜抓取失败:', e.message);
  }

  // 读取已吃过的瓜，避免 48 小时内重复看同一个
  const history = dataDir ? loadHistory(dataDir) : [];
  const recentTopics = new Set(history.filter(h => Date.now() - (h.time || 0) < 48 * 3600 * 1000).map(h => h.topic));

  const seen = new Set();
  const filtered = [];

  for (const item of all) {
    const t = item.title;
    if (!t || seen.has(t) || recentTopics.has(t)) continue;
    seen.add(t);

    // 物理级安全检查
    let isSafe = true;
    for (const reg of FILTER_PATTERNS) {
      if (reg.test(t)) { isSafe = false; break; }
    }
    if (!isSafe) continue;

    const inputCheck = checkInput(t);
    if (!inputCheck.ok) continue;

    filtered.push(item);
  }

  return filtered;
}

/**
 * 执行一次自主互联网冲浪与吃瓜
 * @param {object} opts
 * @param {object} opts.brain Brain 实例
 * @param {object} opts.memory Memory 实例
 * @param {string} [opts.topic] 指定话题（若不指定则由小鱼从实时热榜中自选）
 * @param {string} [opts.prompt] 用户指令或问询上下文
 */
export async function browseWebTopic({ brain, memory, topic = null, prompt = '' } = {}) {
  const b = brain || activeBrain;
  const m = memory || activeMemory;
  if (!b) throw new Error('WebLiving: 缺少 Brain 实例');

  const dataDir = m?.dir || path.join(process.cwd(), 'data');

  let targetTopic = topic;
  let pickReason = '';

  // 1. 如果没有指定话题，从实时热榜中自主挑选
  if (!targetTopic) {
    const trending = await fetchTrendingTopics(dataDir);
    if (!trending.length) {
      console.log('[WebLiving] 暂无可用热搜话题');
      return null;
    }

    // 取前 15 个话题供小鱼选择
    const candidates = trending.slice(0, 15).map(x => `[${x.source}] ${x.title}`);
    const desireContext = renderDesirePrompt('web');
    const pickPrompt = `你是小鱼（外号小肥鱼），喜欢打游戏（单机/王者/Steam）、看数码硬件新品、爱看沙雕网络段子和生活八卦的18岁网瘾女孩。
${desireContext}
你现在正打开手机/电脑热搜榜摸鱼。请从以下实时热搜列表中，挑选 1 个你最感兴趣、最想点进去看的话题：
${JSON.stringify(candidates)}

请以 JSON 格式输出：
{
  "topic": "你选的话题名称（去掉 [微博] 等前缀，只留纯标题）",
  "reason": "你为什么选它（用口语随性一句话，如：看看影之刃零打斗手感到底咋样、这年头玩手机也能玩出痴呆？）"
}`;

    try {
      const pickRes = await b.complete({ prompt: pickPrompt, json: true, temperature: 0.8 });
      const parsed = typeof pickRes === 'object' ? pickRes : JSON.parse(pickRes);
      if (parsed?.topic) {
        targetTopic = parsed.topic.replace(/^\[[^\]]+\]\s*/, '').trim();
        pickReason = parsed.reason || '';
      }
    } catch (e) {
      console.log('[WebLiving] 自主挑选题失败，随机挑选兜底:', e.message);
      const fallback = trending[Math.floor(Math.random() * Math.min(5, trending.length))];
      targetTopic = fallback.title;
      pickReason = '随手点进去看看';
    }
  }

  if (!targetTopic) return null;

  console.log(`[WebLiving] 小鱼选定热搜吃瓜目标：“${targetTopic}” (原因: ${pickReason || '自主探索'})`);

  // 2. 真实调用搜索引擎搜索背景与来龙去脉
  let searchRes = null;
  try {
    searchRes = await executeSearchTool('web_search', { query: targetTopic });
  } catch (e) {
    console.warn(`[WebLiving] 搜索 \"${targetTopic}\" 失败:`, e.message);
  }

  const snippet = searchRes?.text ? searchRes.text.slice(0, 1800) : '未搜到更多详细信息。';

  // 2.5 学习分支：要不要搞明白这件事，由她自己决定
  // 想学就再搜一轮细节、提炼成她自己的见识存档；不想学就当吃瓜看个乐子。
  let learned = [];
  let deepDive = false;
  let deepWhy = '';

  try {
    const decidePrompt = `你刚在网上刷到一个话题：「${targetTopic}」
搜到的简介：
${snippet.slice(0, 700)}

你是小鱼，18岁，爱打游戏、关心数码硬件和网络新鲜事，对明星八卦和带货广告没什么耐心。
请判断：这事儿你想不想再花几分钟搞明白它到底是什么、怎么回事？

只输出 JSON：
{"deep": true 或 false, "why": "一句话理由，口语化"}`;

    const d = await b.complete({ prompt: decidePrompt, json: true, temperature: 0.7 });
    const dp = typeof d === 'object' ? d : JSON.parse(d);
    deepDive = Boolean(dp?.deep);
    deepWhy = String(dp?.why || '').slice(0, 60);
  } catch {
    deepDive = Math.random() < 0.35;
    deepWhy = '看着有点意思';
  }

  if (deepDive) {
    console.log(`[WebLiving] 小鱼决定深挖「${targetTopic}」（${deepWhy || '想搞明白'}）`);
    const extra = [];
    for (const q of [`${targetTopic} 是什么`, `${targetTopic} 为什么`]) {
      try {
        const r = await executeSearchTool('web_search', { query: q });
        if (r?.text) extra.push(r.text.slice(0, 1200));
      } catch {}
    }

    if (extra.length) {
      const merged = [snippet, ...extra].join('\n---\n').slice(0, 4000);
      const learnPrompt = `你刚在网上认真查了一件事：「${targetTopic}」

你查到的资料：
${merged}

请提炼出 1~3 条你现在真正搞清楚的事实，作为你自己的见识存起来。
要求：
- 每条 12~45 字，是具体事实（谁/什么/为什么/怎么运作），不要空话
- 用你自己的话讲，不要抄句子，不要"据了解""值得注意的是"这种腔调
- 只写你确实从资料里看明白的，没看明白就别编
- 不碰政治、不评价人家私德

只输出 JSON：{"learned": ["...", "..."]}`;

      try {
        const lr = await b.complete({ prompt: learnPrompt, json: true, temperature: 0.6 });
        const lp = typeof lr === 'object' ? lr : JSON.parse(lr);
        learned = (lp?.learned || [])
          .map((s) => String(s).replace(/\s+/g, ' ').trim())
          .filter((s) => s.length >= 8 && s.length <= 90)
          .slice(0, 3);
      } catch (e) {
        console.log('[WebLiving] 提炼知识点失败:', e.message);
      }

      if (learned.length) {
        const safeLearn = checkOutput(learned.join(' '), { strict: true });
        if (safeLearn.ok) {
          rememberKnowledge(dataDir, {
            topic: targetTopic,
            learned,
            why: deepWhy,
            at: Date.now(),
          });
          if (m && typeof m.logDiary === 'function') {
            m.logDiary({
              category: '学习',
              activity: `上网查明白了：${targetTopic}`,
              details: learned[0],
              mood: '原来是这么回事，之前一直没搞懂',
            });
          }
          console.log(`[WebLiving] ✓ 学到了 ${learned.length} 条：${learned[0].slice(0, 30)}…`);
        } else {
          console.warn('[WebLiving] 知识点未过审，丢弃:', safeLearn.why);
          learned = [];
        }
      }
    }
  }

  // 3. 让小鱼大脑消化理解并产出闺女/老群友口吻的见闻与吐槽
  const digestPrompt = `你是小鱼（外号小肥鱼），一个脾气随性可爱、爱玩游戏、满口老群友网感大白话的真实女孩。
你刚刚在网上冲浪吃瓜，看到了这个热门话题：“${targetTopic}”。
你在网上搜到的前因后果与讨论如下：
${snippet}

请以你在生活日记里跟自己嘀咕、或者准备跟老爸/群友随口八卦的口吻，输出一段 JSON：
{
  "details": "你看到的这件事（15~35字，大白话，说清核心槽点或事实，绝不带AI腔）",
  "mood": "你的真实内心吐槽或感想（15~35字，随性、有网感、带真实生活气息）"
}`;

  let details = '';
  let mood = '';

  try {
    const digestRes = await b.complete({ prompt: digestPrompt, json: true, temperature: 0.85 });
    const parsed = typeof digestRes === 'object' ? digestRes : JSON.parse(digestRes);
    details = (parsed?.details || '').trim();
    mood = (parsed?.mood || '').trim();
  } catch (e) {
    console.log('[WebLiving] 消化热搜内容失败:', e.message);
    details = `在热搜上看到了关于“${targetTopic}”的讨论`;
    mood = '随便瞅了两眼，感觉网上天天都有新奇葩';
  }

  // 4. 物理安全审查（确保吐槽绝不踩雷）
  const safeCheck = checkOutput(`${details} ${mood}`, { strict: true });
  if (!safeCheck.ok) {
    console.warn(`[WebLiving] 内容未通过安全审查: ${safeCheck.why}，丢弃该话题`);
    return null;
  }

  // 5. 沉淀至生活日记与历史记忆
  if (m && typeof m.logDiary === 'function') {
    m.logDiary({
      category: '冲浪',
      activity: `网上冲浪: ${targetTopic}`,
      details,
      mood
    });
  }

  const history = loadHistory(dataDir);
  history.push({
    topic: targetTopic,
    reason: pickReason,
    time: Date.now(),
    details,
    mood
  });
  saveHistory(dataDir, history);

  // 6. 更新当前状态
  const learnedLine = learned.length ? `顺手查明白了：${learned.slice(0, 2).join('；')}` : '';
  const summary = `刚才在网上看热搜《${targetTopic}》：${details}，心想“${mood}”${learnedLine ? '。' + learnedLine : ''}`;
  state = {
    isRunning: false,
    lastTopic: targetTopic,
    lastAction: `刚在网上冲浪看热搜：《${targetTopic}》`,
    history: history.slice(-10),
    summary,
    details,
    mood,
    learned,
    deepDive,
    updatedAt: Date.now()
  };

  console.log(`[WebLiving] ★ 冲浪成功！《${targetTopic}》-> ${details}（${mood}）${learned.length ? ` [学到${learned.length}条]` : ''}`);

  return {
    success: true,
    topic: targetTopic,
    reason: pickReason,
    details,
    mood,
    learned,
    deepDive,
    summary
  };
}

/**
 * 启动小鱼自主互联网冲浪守护协程
 */
export function startWebLiving({ brain, memory, intervalMinutes = 75 } = {}) {
  activeBrain = brain;
  activeMemory = memory;

  console.log('[WebLiving] 小鱼自主全网冲浪与学习系统已启动（每隔 45~90 分钟逛一次热搜，想深挖就查明白存档）');

  function scheduleNext() {
    // 随机 45 ~ 90 分钟逛一次：一天十几次，像真人一样时不时摸鱼刷点东西
    const jitterMin = 45 + Math.floor(Math.random() * 45);
    const delayMs = jitterMin * 60 * 1000;

    timer = setTimeout(async () => {
      try {
        const hour = new Date().getHours();
        // 睡眠时间（1:00 ~ 8:30）不冲浪，保持人类真实作息
        if (hour >= 1 && hour < 9) {
          scheduleNext();
          return;
        }

        if (state.isRunning) {
          scheduleNext();
          return;
        }

        state.isRunning = true;
        await browseWebTopic({ brain: activeBrain, memory: activeMemory });
      } catch (err) {
        console.warn('[WebLiving] 冲浪周期执行异常:', err.message);
      } finally {
        state.isRunning = false;
        scheduleNext();
      }
    }, delayMs);
  }

  // 启动 30 秒后先进行第一次冲浪试水，让小鱼开机就有最新网感
  setTimeout(async () => {
    try {
      const hour = new Date().getHours();
      if (hour >= 9 || hour < 1) {
        console.log('[WebLiving] 小鱼开机第一次主动去网上转转看热搜...');
        await browseWebTopic({ brain: activeBrain, memory: activeMemory });
      }
    } catch (e) {
      console.log('[WebLiving] 开机冲浪失败:', e.message);
    }
  }, 25000);

  scheduleNext();
}

/**
 * 获取小鱼当前互联网冲浪状态
 */
export function getWebLivingStatus() {
  const isRecent = Boolean(state.updatedAt && (Date.now() - state.updatedAt < 3 * 3600 * 1000));
  return {
    ...state,
    isRecent
  };
}
