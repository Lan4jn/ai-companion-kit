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

  const GAME_PAT = /(游戏|steam|epic|显卡|cpu|装机|主机|单机|联机|怪物猎人|怪猎|荒野|黑神话|三角洲|无畏契约|瓦罗兰特|cs2|csgo|pubg|吃鸡|云顶|原神|星铁|崩铁|绝区零|鸣潮|明日方舟|王者|英雄联盟|lol|s赛|赛季|暴雷|虚幻5|暴雪|网易|腾讯|米哈游|外挂|mod|打折|史低|优化|补丁|开黑|电竞|选手|转会)/i;
  filtered.sort((a, b) => {
    const aGame = GAME_PAT.test(a.title) ? 1 : 0;
    const bGame = GAME_PAT.test(b.title) ? 1 : 0;
    return bGame - aGame;
  });

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
    const pickPrompt = `你是小鱼（外号小肥鱼），是个网瘾很大的18岁游戏宅女，平时最爱单机大作、Steam/主机游戏、硬核射击电竞、数码硬件装机，以及游戏圈的各种离谱乐子、新版本改动与口碑暴雷。
${desireContext}
你现在正打开手机/电脑热榜摸鱼。请从以下实时热搜列表中，【优先挑选】与游戏、电竞、数码硬件、网络名场面最相关的话题；如果实在没有游戏话题，再选沙雕吃瓜吐槽：
${JSON.stringify(candidates)}

请以 JSON 格式输出：
{
  "topic": "你选的话题名称（去掉 [微博] 等前缀，只留纯标题）",
  "reason": "你为什么选它（用口语随性一句话，如：看看怪猎荒野优化到底救回来没、又哪个英雄被砍废了？）"
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
 * 唤起小鱼大脑自省：决定此刻要不要去互联网搜资讯/热搜
 * 真正走一遍大脑认知层，由小鱼自身的心智、状态与近期记忆自主决策
 */
export async function decideWebSurfing({ brain, memory, dataDir } = {}) {
  const b = brain || activeBrain;
  const m = memory || activeMemory;
  if (!b) return { want: false, reason: '缺少大脑实例' };

  const dir = dataDir || (m?.dir ? m.dir : path.join(process.cwd(), 'data'));
  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  // 1. 上次冲浪上下文
  let lastSurfedContext = '你今天还没怎么在网上逛过。';
  if (state.lastTopic && state.updatedAt) {
    const minsAgo = Math.round((Date.now() - state.updatedAt) / 60000);
    lastSurfedContext = `上一次你上网冲浪是在 ${minsAgo} 分钟前，看的话题是「${state.lastTopic}」。`;
  }

  // 2. 最近聊天摘录（帮助小鱼联想近期聊过的游戏或话题）
  let recentChatContext = '';
  try {
    const turnsFile = path.join(dir, 'turns.jsonl');
    if (fs.existsSync(turnsFile)) {
      const lines = fs.readFileSync(turnsFile, 'utf8').trim().split('\n').filter(Boolean);
      const recent = [];
      for (const l of lines.slice(-15)) {
        try {
          const t = JSON.parse(l);
          if (t.text && !t.text.startsWith('【') && t.who !== '系统') {
            const who = t.who || '群友';
            recent.push(`${who}：${t.text.slice(0, 35)}`);
          }
        } catch {}
      }
      if (recent.length) {
        recentChatContext = `\n【最近聊天或群里刚聊到的碎片】：\n- ${recent.slice(-4).join('\n- ')}\n`;
      }
    }
  } catch {}

  const desireContext = renderDesirePrompt('web');
  const prompt = `你是小鱼（外号小肥鱼），是个网瘾很大的18岁游戏宅女，平时最爱单机大作、Steam/主机游戏、硬核射击电竞、数码硬件装机，以及游戏圈的各种离谱乐子与八卦。
${desireContext}
现在是 ${timeStr}。
${lastSurfedContext}
${recentChatContext}
你现在正一个人在电脑/手机前发呆待着。
请问问你自己的内心：这会儿有没有什么冲动想去网上（B站/微博/热搜）转转吃瓜？或者去搜一搜最近关心的游戏/硬件/网络新鲜事？还是说这会儿正歇着发呆，完全不想去搜东西？

【真人网民的真实状态】：
- 真人不会每时每刻都想开网页。如果刚刚聊到好玩的话题脑子还热乎、或者闲着无聊想看看游戏圈有啥新大瓜，就会想去看看（want: true）；
- 如果刚才刚查过、脑子发懵、或者现在只想继续发呆放空歇着，就不会去开网页（want: false）。

请严格以 JSON 格式输出：
{
  "want": true 或 false,
  "reason": "你内心的随性真实想法（口语化，10~30字，如：刚听群友聊怪猎，我得去搜搜最新优化到底咋样 / 刚才看过了，现在脑子有点懵，先趴着放空会儿）",
  "keyword": "如果有特别想查的具体关键词就写出来（如：怪猎荒野优化、270K跑分），如果只是想随便看热搜榜则填空字符串"
}`;

  try {
    const res = await b.complete({ prompt, json: true, temperature: 0.85 });
    const parsed = typeof res === 'object' ? res : JSON.parse(res);
    return {
      want: Boolean(parsed?.want),
      reason: String(parsed?.reason || '').slice(0, 80),
      keyword: String(parsed?.keyword || '').trim().slice(0, 40),
    };
  } catch (e) {
    console.warn('[WebLiving] 大脑自省决策异常:', e.message);
    // 异常时默认不强行冲浪，保持克制
    return { want: false, reason: '大脑走神了，先歇着' };
  }
}

/**
 * 启动小鱼自主互联网冲浪守护协程
 */
export function startWebLiving({ brain, memory, intervalMinutes = 15 } = {}) {
  activeBrain = brain;
  activeMemory = memory;

  console.log('[WebLiving] 小鱼自主全网冲浪系统已启动（每隔 10~20 分钟唤醒大脑层自省，由小鱼自己决定要不要看）');

  function scheduleNext() {
    // 脉冲周期：10 ~ 20 分钟唤醒一次小鱼大脑自省决策
    const jitterMin = 10 + Math.floor(Math.random() * 11);
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

        // ★ 核心改变：走一遍她的大脑层流程，由小鱼自己决定！
        const decision = await decideWebSurfing({ brain: activeBrain, memory: activeMemory });
        if (decision.want) {
          console.log(`[WebLiving] 🧠 小鱼大脑决定去上网冲浪！理由: "${decision.reason}"${decision.keyword ? ` (想查: "${decision.keyword}")` : ''}`);
          state.isRunning = true;
          await browseWebTopic({
            brain: activeBrain,
            memory: activeMemory,
            topic: decision.keyword || null,
            prompt: decision.reason
          });
        } else {
          console.log(`[WebLiving] 🧠 小鱼大脑自省：这会儿不想上网（理由: "${decision.reason || '想先发呆放空'}"）`);
        }
      } catch (err) {
        console.warn('[WebLiving] 冲浪周期执行异常:', err.message);
      } finally {
        state.isRunning = false;
        scheduleNext();
      }
    }, delayMs);
  }

  // 启动 20 秒后先进行第一次开机自省体验
  setTimeout(async () => {
    try {
      const hour = new Date().getHours();
      if (hour >= 9 || hour < 1) {
        const decision = await decideWebSurfing({ brain: activeBrain, memory: activeMemory });
        if (decision.want) {
          console.log(`[WebLiving] 🧠 小鱼开机自省：决定去网上看一眼！理由: "${decision.reason}"`);
          await browseWebTopic({ brain: activeBrain, memory: activeMemory, topic: decision.keyword || null, prompt: decision.reason });
        } else {
          console.log(`[WebLiving] 🧠 小鱼开机自省：刚醒先趴会儿，不想去网上看热搜（理由: "${decision.reason}"）`);
        }
      }
    } catch (e) {
      console.log('[WebLiving] 开机自省失败:', e.message);
    }
  }, 20000);

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
