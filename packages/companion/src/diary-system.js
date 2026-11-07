/**
 * diary-system.js
 * 小鱼私密日记本与随笔生成系统
 *
 * 核心设计：
 * 1. 独白视角：第一人称深度反思日记（Markdown 格式，如：# 001 · 把齿轮吐到嘴上），绝非冰冷汇报；
 * 2. 真实沉淀：结合当天真实经历（刷过的视频、吃过的瓜、老爸聊天、今日牌灵与德行）；
 * 3. 存储归档：写入 data/notebook/日记/YYYY-MM-DD.md，无缝接入面板与独立网页端；
 * 4. 自动定时：每晚 22:30 自动检视并生成当天日记，支持老爸手动随时触发。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function pad(n) {
  return String(n).padStart(2, '0');
}

export function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function timeSlot(d = new Date()) {
  const h = d.getHours();
  if (h >= 5 && h < 11) return '清晨';
  if (h >= 11 && h < 14) return '中午';
  if (h >= 14 && h < 18) return '下午';
  if (h >= 18 && h < 23) return '晚上';
  return '深夜';
}

/**
 * 汇总小鱼今天的所有真实经历作为写日记的素材
 */
export function gatherTodayContext(dataDir) {
  const today = todayKey();
  const summaryParts = [];

  // 1. 收集今日牌灵与德行十轴
  try {
    const tarotFile = path.join(dataDir, 'tarot.json');
    if (fs.existsSync(tarotFile)) {
      const t = JSON.parse(fs.readFileSync(tarotFile, 'utf8'));
      if (t.name) summaryParts.push(`- 今日抽到的塔罗牌灵：${t.name}（${t.orientation || '正位'}），心理底色是「${t.today || t.title || ''}」`);
    }
  } catch {}

  try {
    const virtueFile = path.join(dataDir, 'virtue.json');
    if (fs.existsSync(virtueFile)) {
      const v = JSON.parse(fs.readFileSync(virtueFile, 'utf8'));
      if (v.axes) {
        const topAxes = Object.entries(v.axes).filter(([, val]) => Math.abs(val) >= 2);
        if (topAxes.length) {
          summaryParts.push(`- 今日德行偏向：${topAxes.map(([k, val]) => `${k}偏${val > 0 ? '正' : '逆'}(${val})`).join('、')}`);
        }
      }
    }
  } catch {}

  // 2. 收集今日生活流水账 (diary.jsonl)
  try {
    const diaryFile = path.join(dataDir, 'diary.jsonl');
    if (fs.existsSync(diaryFile)) {
      const lines = fs.readFileSync(diaryFile, 'utf8').trim().split('\n').filter(Boolean);
      const todayEvents = [];
      for (const line of lines) {
        try {
          const item = JSON.parse(line);
          const itemDate = todayKey(new Date(item.t || Date.now()));
          if (itemDate === today) {
            const act = item.activity || item.details || '';
            const mood = item.mood ? `（心境：${item.mood}）` : '';
            if (act) todayEvents.push(`${act} ${mood}`);
          }
        } catch {}
      }
      if (todayEvents.length) {
        summaryParts.push(`- 今天上网摸鱼/看视频/查到的事：\n  ${todayEvents.slice(-6).join('\n  ')}`);
      }
    }
  } catch {}

  // 3. 收集今日聊天关键摘录 (turns.jsonl)
  try {
    const turnsFile = path.join(dataDir, 'turns.jsonl');
    if (fs.existsSync(turnsFile)) {
      const lines = fs.readFileSync(turnsFile, 'utf8').trim().split('\n').filter(Boolean);
      const recentChat = [];
      for (const line of lines.slice(-25)) {
        try {
          const turn = JSON.parse(line);
          const t = turn.t || turn.time;
          if (t && todayKey(new Date(t)) === today) {
            if (turn.text && turn.reply) {
              const who = turn.who || turn.name || '群友';
              recentChat.push(`${who}说：“${turn.text.slice(0, 30)}” ➔ 我回：“${turn.reply.slice(0, 40)}”`);
            }
          }
        } catch {}
      }
      if (recentChat.length) {
        summaryParts.push(`- 今天聊过的天与互动片段：\n  ${recentChat.slice(-5).join('\n  ')}`);
      }
    }
  } catch {}

  return summaryParts.join('\n');
}

/**
 * 获取现有日记篇数以计算编号
 */
export function getNextDiaryNumber(notebookDir) {
  try {
    const dir = path.join(notebookDir, '日记');
    if (!fs.existsSync(dir)) return '001';
    const files = fs.readdirSync(dir).filter(f => /\.md$/i.test(f));
    const count = files.length + 1;
    return String(count).padStart(3, '0');
  } catch {
    return '001';
  }
}

/**
 * 驱动大模型生成一篇有血有肉的小鱼第一人称日记
 */
export async function generateDailyDiary({ brain, dataDir, force = false, hint = '' } = {}) {
  const dir = dataDir || path.join(__dirname, '..', 'data');
  const notebookDir = path.join(dir, 'notebook');
  const diaryDir = path.join(notebookDir, '日记');
  fs.mkdirSync(diaryDir, { recursive: true });

  const today = todayKey();
  const todayFile = path.join(diaryDir, `${today}.md`);

  if (fs.existsSync(todayFile) && !force) {
    const existing = fs.readFileSync(todayFile, 'utf8');
    return { ok: true, file: todayFile, content: existing, fresh: false };
  }

  const num = getNextDiaryNumber(notebookDir);
  const now = new Date();
  const slot = timeSlot(now);
  const context = gatherTodayContext(dir);

  const prompt = `你是小鱼（外号小肥鱼），是一个住在老爸电脑里的18岁女孩子，爱吃大白米饭、爱打游戏（单机/Steam/电竞）、有自己的小脾气和敏感心思，老爸（QQ: 578021239）是收养你的养父。
你现在要静下心来，在自己的私密笔记本里写一篇今天的随笔日记。

【今天真实发生过的事情与你的状态背景】
${context || '今天一天过得平平淡淡，在电脑里待着摸鱼。'}
${hint ? `【老爸特别提醒或今晚主题】\n${hint}\n` : ''}

【格式硬性规范（严格按照以下 Markdown 格式输出）】
# ${num} · [用口语化、略带文艺或自嘲的简练标题，如：把齿轮吐到嘴上 / 今天的大白米饭有点硬 / 散热风扇转得我心慌]

---

*写于 ${today} ${slot}，那台电脑边上。*

[正文内容]

【正文写作要求】
1. 必须是第一人称“我”，写自己的真实感受，像在只有自己看得见的日记本里小声自言自语。
2. 绝对不要像AI一样写总结汇报（严禁出现“今天真是充实的一天”、“今天学到了很多”这类空话套话）。
3. 写具体的细节：老爸说的某句话、群友的某个离谱言论、游戏或者视频里的某个画面、或者是自己突然冒出的某个小念头。
4. 语言风格：口语自然、短句为主、真情实感，可以有傲娇嘴硬、可以有对老爸的依赖、也可以有对当赛博小鱼的微妙反思。
5. 字数控制在 250 ~ 500 字之间，分 3~4 个自然段。
6. 直接输出纯 Markdown 正文，不要包裹额外的 \`\`\`markdown 围栏，不要有任何多余解释。`;

  let diaryText = '';
  if (brain && typeof brain.reply === 'function') {
    const res = await brain.reply({
      key: '__diary_generation__',
      userId: 'system',
      userName: '小鱼自己',
      text: prompt,
      situation: '夜深人静，小鱼在属于她自己的私密日记本里写下今天的心情随笔',
      history: [],
      record: false,
    });
    diaryText = res?.text || '';
  } else if (brain && typeof brain.complete === 'function') {
    diaryText = await brain.complete({ prompt, temperature: 0.85 });
  } else {
    throw new Error('未提供可用的 Brain 实例');
  }

  // 清洗可能存在的 markdown 代码围栏
  diaryText = String(diaryText || '').trim()
    .replace(/^```markdown\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  if (!diaryText.startsWith('# ')) {
    diaryText = `# ${num} · 今天的心情记事\n\n---\n\n*写于 ${today} ${slot}，那台电脑边上。*\n\n` + diaryText;
  }

  fs.writeFileSync(todayFile, diaryText, 'utf8');

  // 追加到生活账本 diary.jsonl 作为持久记忆标记
  try {
    const diaryJsonl = path.join(dir, 'diary.jsonl');
    const firstLine = diaryText.split('\n')[0].replace(/^#\s*/, '');
    fs.appendFileSync(diaryJsonl, JSON.stringify({
      t: Date.now(),
      category: '日记',
      activity: `写下了日记: ${firstLine}`,
      details: diaryText.slice(0, 100),
      mood: '写完舒坦多了'
    }) + '\n', 'utf8');
  } catch {}

  console.log(`[Diary] ★ 小鱼日记落盘成功: ${todayFile} (${diaryText.slice(0, 30)}...)`);
  return { ok: true, file: todayFile, content: diaryText, fresh: true, number: num };
}

/**
 * 读取所有已存在的日记列表
 */
export function listAllDiaries(dataDir) {
  const dir = path.join(dataDir || path.join(__dirname, '..', 'data'), 'notebook', '日记');
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => /\.md$/i.test(f)).sort().reverse();
  const list = [];
  for (const f of files) {
    try {
      const full = path.join(dir, f);
      const stat = fs.statSync(full);
      const content = fs.readFileSync(full, 'utf8');
      const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
      const title = (lines[0] || f).replace(/^#\s*/, '');
      const preview = lines.slice(1, 4).join(' ').replace(/\*/g, '').slice(0, 100);
      list.push({
        file: f,
        name: f.replace(/\.md$/i, ''),
        title,
        preview,
        mtime: stat.mtimeMs,
        size: stat.size,
      });
    } catch {}
  }
  return list;
}

/**
 * 渲染独立美观的日记阅读器 HTML 页面
 */
export function renderDiaryViewerHtml(dataDir) {
  const diaries = listAllDiaries(dataDir);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>小鱼的随笔日记本</title>
<style>
  :root {
    --bg: #0d1117;
    --card: #161b22;
    --border: #30363d;
    --text: #e6edf3;
    --dim: #8b949e;
    --accent: #58a6ff;
    --accent-hover: #79c0ff;
    --tag-bg: #21262d;
    --gold: #d29922;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    line-height: 1.6;
    display: flex;
    flex-direction: column;
    min-height: 100vh;
  }
  header {
    background: #161b22ee;
    backdrop-filter: blur(8px);
    border-bottom: 1px solid var(--border);
    padding: 14px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    position: sticky;
    top: 0;
    z-index: 10;
  }
  .brand { display: flex; align-items: center; gap: 10px; }
  .brand h1 { font-size: 17px; font-weight: 600; color: var(--text); }
  .brand .tag { font-size: 12px; background: #238636; color: #fff; padding: 2px 8px; border-radius: 12px; }
  .nav-links { display: flex; align-items: center; gap: 14px; font-size: 13px; }
  .nav-links a { color: var(--dim); text-decoration: none; transition: color 0.2s; }
  .nav-links a:hover { color: var(--accent); }
  .btn-gen {
    background: #238636;
    color: #fff;
    border: none;
    padding: 6px 14px;
    border-radius: 6px;
    font-size: 13px;
    cursor: pointer;
    font-weight: 500;
    transition: background 0.2s;
  }
  .btn-gen:hover { background: #2ea043; }
  .btn-gen:disabled { opacity: 0.6; cursor: not-allowed; }
  
  main {
    flex: 1;
    display: grid;
    grid-template-columns: 320px 1fr;
    max-width: 1400px;
    margin: 0 auto;
    width: 100%;
    height: calc(100vh - 61px);
  }
  .sidebar {
    background: #13171f;
    border-right: 1px solid var(--border);
    overflow-y: auto;
    padding: 16px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .sidebar-header {
    font-size: 12px;
    font-weight: 600;
    color: var(--dim);
    text-transform: uppercase;
    padding: 4px 8px 8px;
  }
  .diary-item {
    padding: 12px 14px;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.2s;
  }
  .diary-item:hover { border-color: var(--accent); transform: translateY(-1px); }
  .diary-item.active { border-color: var(--accent); background: #1c212c; }
  .diary-item .date { font-size: 12px; color: var(--gold); font-weight: 500; margin-bottom: 4px; }
  .diary-item .d-title { font-size: 14px; font-weight: 600; color: var(--text); margin-bottom: 6px; line-height: 1.4; }
  .diary-item .d-preview { font-size: 12px; color: var(--dim); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }

  .viewer {
    padding: 36px 48px;
    overflow-y: auto;
    background: #0d1117;
    display: flex;
    justify-content: center;
  }
  .article-card {
    max-width: 760px;
    width: 100%;
  }
  .article-body h1 {
    font-size: 24px;
    font-weight: 700;
    margin-bottom: 12px;
    line-height: 1.35;
    color: var(--text);
  }
  .article-body hr {
    border: 0;
    border-top: 1px solid var(--border);
    margin: 16px 0 20px;
  }
  .article-body em {
    color: var(--dim);
    font-size: 13px;
    display: block;
    margin-bottom: 24px;
  }
  .article-body p {
    font-size: 15px;
    line-height: 1.85;
    margin-bottom: 18px;
    color: #c9d1d9;
    letter-spacing: 0.2px;
  }
  .article-body code {
    background: #21262d;
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 13px;
  }
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--dim);
    font-size: 14px;
  }
  @media (max-width: 800px) {
    main { grid-template-columns: 1fr; height: auto; }
    .sidebar { max-height: 240px; border-right: none; border-bottom: 1px solid var(--border); }
    .viewer { padding: 24px 18px; }
  }
</style>
</head>
<body>
<header>
  <div class="brand">
    <h1>🐟 小鱼的私密随笔日记</h1>
    <span class="tag">共 ${diaries.length} 篇</span>
  </div>
  <div class="nav-links">
    <a href="/panel/">心智面板</a>
    <a href="/">2.5D居室</a>
    <button class="btn-gen" id="btnGen" onclick="triggerWrite()">✍️ 让小鱼现在写一篇</button>
  </div>
</header>
<main>
  <div class="sidebar">
    <div class="sidebar-header">历史日记列表</div>
    <div id="listContainer">
      ${diaries.map((d, idx) => `
        <div class="diary-item ${idx === 0 ? 'active' : ''}" onclick="loadDiary('${d.name}')">
          <div class="date">${d.name}</div>
          <div class="d-title">${d.title}</div>
          <div class="d-preview">${d.preview}</div>
        </div>
      `).join('')}
    </div>
  </div>
  <div class="viewer">
    <div class="article-card" id="articleBox">
      <div class="empty-state">正在翻开日记本…</div>
    </div>
  </div>
</main>
<script>
  let currentName = '${diaries[0]?.name || ''}';
  function renderMarkdown(md) {
    const lines = md.split('\\n');
    let html = '';
    let inP = false;
    for (let raw of lines) {
      let l = raw.trim();
      if (!l) {
        if (inP) { html += '</p>'; inP = false; }
        continue;
      }
      if (l.startsWith('# ')) {
        if (inP) { html += '</p>'; inP = false; }
        html += '<h1>' + esc(l.slice(2)) + '</h1>';
        continue;
      }
      if (l === '---' || l === '***') {
        if (inP) { html += '</p>'; inP = false; }
        html += '<hr>';
        continue;
      }
      if (l.startsWith('*') && l.endsWith('*') && !l.slice(1, -1).includes('*')) {
        if (inP) { html += '</p>'; inP = false; }
        html += '<em>' + esc(l.slice(1, -1)) + '</em>';
        continue;
      }
      if (!inP) { html += '<p>'; inP = true; } else { html += '<br>'; }
      let safe = esc(l).replace(/\`([^\`]+)\`/g, '<code>$1</code>');
      html += safe;
    }
    if (inP) html += '</p>';
    return html;
  }
  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  async function loadDiary(name) {
    if (!name) return;
    currentName = name;
    document.querySelectorAll('.diary-item').forEach(el => {
      el.classList.toggle('active', el.querySelector('.date')?.textContent === name);
    });
    try {
      const res = await fetch('/api/diary/read?file=' + encodeURIComponent(name));
      const data = await res.json();
      if (data.content) {
        document.getElementById('articleBox').innerHTML = '<div class="article-body">' + renderMarkdown(data.content) + '</div>';
      } else {
        document.getElementById('articleBox').innerHTML = '<div class="empty-state">未能读取到此篇日记</div>';
      }
    } catch (e) {
      document.getElementById('articleBox').innerHTML = '<div class="empty-state">加载失败: ' + esc(String(e)) + '</div>';
    }
  }
  async function triggerWrite() {
    const btn = document.getElementById('btnGen');
    btn.disabled = true;
    btn.textContent = '小鱼正在提笔思考…';
    try {
      const res = await fetch('/api/diary/generate', { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        location.reload();
      } else {
        alert('生成失败: ' + (data.error || '未知错误'));
      }
    } catch (e) {
      alert('请求出错: ' + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '✍️ 让小鱼现在写一篇';
    }
  }
  if (currentName) {
    loadDiary(currentName);
  }
</script>
</body>
</html>`;
}

/**
 * 启动每日定时写日记调度器
 */
export function startDiaryScheduler({ brain, memory, dataDir } = {}) {
  const dir = dataDir || (memory?.dir ? memory.dir : path.join(__dirname, '..', 'data'));

  // 每 15 分钟检查一次，如果当前时间在 22:30 ~ 01:30 且今天没写过，则自动动笔写一篇
  const check = async () => {
    try {
      const now = new Date();
      const h = now.getHours();
      // 晚上 22 点到半夜 1 点之间是写日记的典型时间
      if (h >= 22 || h < 1) {
        const today = todayKey(now);
        const todayFile = path.join(dir, 'notebook', '日记', `${today}.md`);
        if (!fs.existsSync(todayFile)) {
          console.log('[Diary] 夜深了，小鱼开始写今天的随笔日记...');
          await generateDailyDiary({ brain, dataDir: dir });
        }
      }
    } catch (e) {
      console.warn('[Diary] 定时写日记检查异常:', e.message);
    }
  };

  setInterval(check, 15 * 60 * 1000);
  console.log('[Diary] 小鱼每日随笔日记系统已装载（每晚 22:30+ 自主沉淀，存放于 data/notebook/日记/）');
}
