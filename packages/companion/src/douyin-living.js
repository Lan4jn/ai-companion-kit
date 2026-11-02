/**
 * 小鱼真实刷抖音生活系统（Douyin Living）
 *
 * 1. 自动抓取抖音精选/推荐视频流（标题、文案、作者、时长、点赞与话题标签）。
 * 2. 真实融入小鱼的生活日记（diary.jsonl）与即时思维账本。
 * 3. 联动虚拟小房间（Virtual Room）动作切换：刷抖音时小鱼爬上椅子打开电脑。
 * 4. 支持老爸在 QQ 里查岗（“去刷刷抖音汇报一下”、“在干嘛”），小鱼实时汇报最新刷到的短视频与吐槽。
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { registerActivePage, unregisterActivePage, updatePageMeta, saveSnapshot } from './browser-observer.js';

const CHROME_PATH = '/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome';

let activeBrain = null;
let activeMemory = null;
let activeRoom = null;
let timer = null;

let state = {
  isRunning: false,
  lastAction: '刚躺回床上歇着',
  lastVideo: null,
  history: [],
  summary: '',
  updatedAt: Date.now(),
};

function readCachedFeed(dataDir) {
  try {
    const f = path.join(dataDir, 'douyin-feed.json');
    if (fs.existsSync(f)) {
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    }
  } catch {}
  return [];
}

function writeCachedFeed(dataDir, feed) {
  try {
    const f = path.join(dataDir, 'douyin-feed.json');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(feed, null, 2), 'utf8');
  } catch (e) {
    console.log('[douyin] 缓存写入失败:', e?.message || e);
  }
}

/**
 * 无头浏览器抓取抖音推荐视频列表
 */
export async function fetchDouyinFeed() {
  let browser = null;
  let page = null;
  try {
    browser = await chromium.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 720 },
    });

    // 载入已保存的登录凭据（如果已登录）
    try {
      const cookieFile = path.join('/root/ai-companion-xiaoyu/ai-companion-kit/packages/companion/data', 'douyin-cookies.json');
      if (fs.existsSync(cookieFile)) {
        const savedCookies = JSON.parse(fs.readFileSync(cookieFile, 'utf8'));
        if (Array.isArray(savedCookies) && savedCookies.length > 0) {
          await context.addCookies(savedCookies);
          console.log(`[douyin] 已载入 ${savedCookies.length} 条登录 Cookie`);
        }
      }
    } catch (e) {
      console.log('[douyin] 载入 Cookie 异常:', e.message);
    }

    page = await context.newPage();
    registerActivePage(page, { platform: 'douyin', title: '抖音精选推荐流', url: 'https://www.douyin.com/?recommend=1' });

    await page.goto('https://www.douyin.com/?recommend=1', { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(3000);

    // 关闭未登录遮罩弹窗（若有）
    try {
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('div, span, button, svg'));
        const closeBtn = btns.find(b => b.innerText === '✕' || b.className?.includes?.('close') || b.getAttribute('aria-label')?.includes?.('关闭'));
        if (closeBtn) closeBtn.click();
      });
    } catch {}

    // 观察器抓取当前实时画面，让只读观察器能随时看到
    try {
      const snap = await page.screenshot({ type: 'jpeg', quality: 75 });
      saveSnapshot(snap, { platform: 'douyin', title: '抖音精选推荐流' });
    } catch {}

    // 拟人化慢速滚动浏览 8 秒，给只读监视器展示真实的浏览翻看动作
    await page.evaluate(() => window.scrollBy({ top: 400, behavior: 'smooth' }));
    await page.waitForTimeout(4000);
    try {
      const snap2 = await page.screenshot({ type: 'jpeg', quality: 75 });
      saveSnapshot(snap2, { platform: 'douyin', title: '抖音精选推荐流 (翻页浏览中)' });
    } catch {}
    await page.evaluate(() => window.scrollBy({ top: 400, behavior: 'smooth' }));
    await page.waitForTimeout(4000);

    const items = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('*'));
      const rawList = [];
      for (const el of all) {
        if (el.children.length > 1 && el.children.length < 10) {
          const text = el.innerText || '';
          if (text.includes('@') && text.length > 15 && text.length < 350) {
            rawList.push(text);
          }
        }
      }
      const unique = [];
      for (const t of rawList) {
        if (!unique.some((u) => u.includes(t) || t.includes(u))) {
          unique.push(t);
        }
      }
      return unique;
    });

    const parsed = items.map((raw) => {
      const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
      let duration = '';
      let views = '';
      let author = '';
      let timeAgo = '';
      let title = '';

      for (const line of lines) {
        if (/^\d{2}:\d{2}$/.test(line)) duration = line;
        else if (/^\d+(\.\d+)?[万亿]?$/.test(line) && !views) views = line;
        else if (line.startsWith('@')) author = line;
        else if (line.includes('天前') || line.includes('小时前') || line.includes('月前') || line.includes('周前')) timeAgo = line;
        else if (line.length > 8 && !title) title = line;
      }

      if (!title && lines.length > 0) {
        title = lines.find((l) => l.length > 6 && !l.startsWith('@') && !l.includes('天前')) || lines[0];
      }

      return {
        title: title || raw.slice(0, 50),
        author: author || '未知创作者',
        duration: duration || '00:30',
        views: views || '1万',
        timeAgo: timeAgo || '近期',
        raw,
      };
    }).filter((x) => x.title && x.title.length > 5);

    return parsed;
  } catch (e) {
    console.log('[douyin] 抓取失败: ' + (e?.message || e));
    return [];
  } finally {
    if (page) unregisterActivePage(page);
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
}

/**
 * 触发一次真实的刷抖音流程
 */
export async function browseDouyinLive({ isOwner = true, prompt = '' } = {}) {
  // 1. 房间状态切到书桌电脑前
  if (activeRoom) {
    activeRoom.setState('desk_laptop', {
      action: '在电脑前刷抖音',
      message: '收到！这就爬到电脑前刷会儿抖音给你汇报~',
    });
  }

  // 2. 抓取真实抖音内容
  const dataDir = activeMemory?.dataDir || '/root/ai-companion-xiaoyu/ai-companion-kit/packages/companion/data';
  let feed = await fetchDouyinFeed();
  if (!feed || feed.length === 0) {
    feed = readCachedFeed(dataDir);
  } else {
    writeCachedFeed(dataDir, feed);
  }

  if (!feed || feed.length === 0) {
    // 基础保底
    feed = [
      {
        title: '猫咪被绝育后的绝望眼神 #沙雕宠物 #猫咪日常',
        author: '@咪咪大探险',
        duration: '00:45',
        views: '28.3万',
      },
      {
        title: '三角洲新刀皮最全细节展示-黑伤 #三角洲行动 #FPS',
        author: '@老飞宇66',
        duration: '01:17',
        views: '18.4万',
      },
    ];
  }

  // 选一个没看过的，或者随机挑一个
  const pick = feed[Math.floor(Math.random() * Math.min(feed.length, 5))];
  state.lastVideo = pick;
  state.lastAction = `在电脑上刷到了 ${pick.author} 发的《${pick.title.slice(0, 25)}》`;
  state.updatedAt = Date.now();

  // 3. 让大脑生成一段地道的老群友短视频点评
  let thought = `刚在抖音刷到了 ${pick.author} 的《${pick.title}》，点赞都 ${pick.views} 了，看完了挺有意思的。`;
  if (activeBrain) {
    try {
      const res = await activeBrain.reply({
        key: 'internal:douyin',
        userId: 'system',
        userName: '系统',
        text: `【请以小鱼自己的第一人称口吻写一句简短吐槽（20~50字）】：\n你刚才打开电脑刷抖音，推荐流第一条刷到了：\n标题：《${pick.title}》\n作者：${pick.author}\n播放/点赞：${pick.views}\n请真实自然地说说你看了之后的感受或槽点（老群友随性说话，禁止任何括号描写和机械套话）。`,
        situation: '你刚刚按老爸要求或自己摸鱼打开电脑看了一条抖音视频。',
      });
      if (res && res.text) {
        thought = res.text.trim();
      }
    } catch (e) {
      console.log('[douyin] Brain 生成感悟失败:', e?.message || e);
    }
  }

  state.summary = `刚刷完抖音《${pick.title.slice(0, 20)}》：${thought}`;

  // 4. 记入日记
  try {
    const diaryFile = path.join(dataDir, 'diary.jsonl');
    const entry = {
      category: '短视频',
      activity: '刷抖音',
      title: pick.title,
      author: pick.author,
      thought,
      at: new Date().toISOString(),
    };
    fs.appendFileSync(diaryFile, JSON.stringify(entry) + '\n', 'utf8');
  } catch (e) {}

  // 5. 更新房间对话气泡
  if (activeRoom) {
    activeRoom.setState('desk_laptop', {
      action: '刚刷完一条抖音',
      message: thought,
    });
    // 40 秒后自动回床上躺平摸鱼
    setTimeout(() => {
      activeRoom.setState('bed_phone', {
        action: '回床上躺着玩手机',
        message: '刷完啦，继续回床上瘫着~',
      });
    }, 45000);
  }

  return {
    video: pick,
    thought,
    report: `开了，电脑上正刷着呢。\n第一条刷到了 ${pick.author} 的《${pick.title.slice(0, 28)}》：${thought}`,
  };
}

export function getDouyinLivingStatus() {
  return {
    ...state,
    isRecent: Date.now() - state.updatedAt < 30 * 60 * 1000,
  };
}

export function setDouyinRoom(room) {
  activeRoom = room;
}

/**
 * 启动抖音生活定时轮巡（自主摸鱼机制）
 */
export function startDouyinLiving({ brain, memory, room, intervalMin = 90 } = {}) {
  activeBrain = brain;
  activeMemory = memory;
  if (room) activeRoom = room;

  console.log('[DouyinLiving] 抖音自主摸鱼系统已启动（每隔 60~120 分钟逛一次推荐流）');

  const scheduleNext = () => {
    const nextMs = (60 + Math.random() * 60) * 60 * 1000;
    timer = setTimeout(async () => {
      const h = new Date().getHours();
      // 只在白天到深夜（10:00 - 24:00）摸鱼
      if (h >= 10 && h <= 24) {
        try {
          console.log('[DouyinLiving] 小鱼开始在电脑前摸鱼刷抖音...');
          await browseDouyinLive({ isOwner: false });
        } catch (e) {
          console.log('[DouyinLiving] 自动摸鱼异常:', e?.message || e);
        }
      }
      scheduleNext();
    }, nextMs);
  };

  scheduleNext();
}

export default {
  startDouyinLiving,
  fetchDouyinFeed,
  browseDouyinLive,
  getDouyinLivingStatus,
  setDouyinRoom,
};
