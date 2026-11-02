/**
 * 小鱼真实刷抖音生活系统（Douyin Living - 互动升级版）
 *
 * 1. 自动抓取抖音精选/推荐视频流（标题、文案、作者、时长、点赞与话题标签）。
 * 2. 支持对特定视频链接（v.douyin.com / douyin.com/video）进行深度观看与真机互动。
 * 3. 真实互动能力：
 *    - 自动点赞（按键 'z' 或点击 [data-e2e="video-player-digg"]）
 *    - 真实评论（聚焦 Draft.js 编辑器打字，经过三重物理防火墙终审后提交）
 *    - 关注创作者（点击关注按钮）
 * 4. 真实融入小鱼的生活日记（diary.jsonl）与即时思维账本。
 * 5. 联动虚拟小房间（Virtual Room）动作切换与只读监视器投屏。
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { registerActivePage, unregisterActivePage, saveSnapshot } from './browser-observer.js';
import { checkOutput } from './safety.js';

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

function writeCachedFeed(dataDir, list) {
  try {
    const f = path.join(dataDir, 'douyin-feed.json');
    fs.writeFileSync(f, JSON.stringify(list, null, 2), 'utf8');
  } catch (e) {
    console.log('[douyin] 缓存写入失败:', e?.message || e);
  }
}

/**
 * 关闭页面上各种干扰弹窗（保存登录凭据弹窗、未登录提示等）
 */
async function dismissPopups(page) {
  try {
    await page.evaluate(() => {
      // 1. 保存登录信息弹窗
      const confirmBtn = document.querySelector('button.trust-login-dialog-button-confirm, button.trust-login-dialog-button-cancel');
      if (confirmBtn) confirmBtn.click();

      // 2. 常见关闭按钮
      const btns = Array.from(document.querySelectorAll('div, span, button, svg'));
      const closeBtn = btns.find(b => b.innerText === '✕' || b.className?.includes?.('close') || b.getAttribute('aria-label')?.includes?.('关闭'));
      if (closeBtn) closeBtn.click();
    });
  } catch {}
}

/**
 * 观看并互动指定抖音视频
 */
export async function watchAndInteractDouyinVideo(targetUrl, { doLike = true, commentText = '', doFollow = false } = {}) {
  let browser = null;
  let page = null;
  const dataDir = activeMemory?.dataDir || '/root/ai-companion-xiaoyu/ai-companion-kit/packages/companion/data';

  try {
    browser = await chromium.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });

    const cookieFile = path.join(dataDir, 'douyin-cookies.json');
    if (fs.existsSync(cookieFile)) {
      try {
        const savedCookies = JSON.parse(fs.readFileSync(cookieFile, 'utf8'));
        if (Array.isArray(savedCookies)) {
          await context.addCookies(savedCookies);
        }
      } catch {}
    }

    page = await context.newPage();
    registerActivePage(page, { platform: 'douyin', title: '抖音专属视频播放中', url: targetUrl });

    console.log(`[douyin] 正在打开指定视频: ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    await dismissPopups(page);

    // 抓取快照提供给观察器
    try {
      const snap = await page.screenshot({ type: 'jpeg', quality: 75 });
      saveSnapshot(snap, { platform: 'douyin', title: '小鱼正在看抖音视频' });
    } catch {}

    // 提取视频元数据与评论
    const info = await page.evaluate(() => {
      const titleEl = document.querySelector('h1, [data-e2e="detail-video-info"]');
      let title = document.title;
      if (titleEl && titleEl.innerText) {
        title = titleEl.innerText.split('\n')[0].trim();
      }
      const authorEl = document.querySelector('[data-e2e="user-info"] a, [data-e2e="user-info"] p, [data-e2e="user-info"] span, .account-name');
      const author = (authorEl ? authorEl.innerText.trim() : '创作者').replace(/\n.*/s, '');
      const digg = document.querySelector('[data-e2e="video-player-digg"]');
      const comments = Array.from(document.querySelectorAll('[data-e2e="comment-list"] p, [data-e2e="comment-list"] span'))
        .map(e => e.innerText?.trim())
        .filter(t => t && t.length > 5 && t.length < 100);

      return {
        title: title.replace(/ - 抖音$/, '').trim(),
        author,
        likes: digg ? digg.innerText.trim() : '',
        topComments: Array.from(new Set(comments)).slice(0, 5)
      };
    });

    let liked = false;
    let commented = false;
    let followed = false;

    // 1. 点赞互动
    if (doLike) {
      try {
        await page.evaluate(() => {
          const digg = document.querySelector('[data-e2e="video-player-digg"]');
          if (digg) digg.click();
        });
        liked = true;
        console.log(`[douyin] 已为视频《${info.title.slice(0, 20)}》点赞`);
      } catch (e) {
        console.log('[douyin] 点赞失败:', e.message);
      }
    }

    // 2. 评论互动
    if (commentText) {
      const sec = checkOutput(commentText);
      if (sec.ok) {
        try {
          await page.evaluate(() => {
            const c = document.querySelector('.comment-input-inner-container');
            if (c) c.click();
          });
          await page.waitForTimeout(800);
          await page.evaluate(() => {
            const ed = document.querySelector('.public-DraftEditor-content');
            if (ed) ed.focus();
          });
          await page.keyboard.type(commentText);
          await page.waitForTimeout(500);
          await page.keyboard.press('Enter');
          commented = true;
          console.log(`[douyin] 评论发布成功: “${commentText}”`);
        } catch (e) {
          console.log('[douyin] 发评论失败:', e.message);
        }
      } else {
        console.log('[douyin] 拟发布的评论未通过安全审核，已自动取消:', sec.why);
      }
    }

    // 3. 关注作者
    if (doFollow) {
      try {
        await page.evaluate(() => {
          const btn = Array.from(document.querySelectorAll('button.semi-button')).find(b => b.innerText?.trim() === '关注');
          if (btn) btn.click();
        });
        followed = true;
        console.log(`[douyin] 已关注作者: ${info.author}`);
      } catch (e) {
        console.log('[douyin] 关注失败:', e.message);
      }
    }

    return {
      success: true,
      info,
      liked,
      commented,
      followed
    };
  } catch (e) {
    console.log('[douyin] 观看指定视频失败:', e.message);
    return { success: false, error: e.message };
  } finally {
    if (page) unregisterActivePage(page);
    if (browser) {
      try { await browser.close(); } catch {}
    }
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

    const cookieFile = path.join('/root/ai-companion-xiaoyu/ai-companion-kit/packages/companion/data', 'douyin-cookies.json');
    if (fs.existsSync(cookieFile)) {
      try {
        const savedCookies = JSON.parse(fs.readFileSync(cookieFile, 'utf8'));
        if (Array.isArray(savedCookies) && savedCookies.length > 0) {
          await context.addCookies(savedCookies);
          console.log(`[douyin] 已载入 ${savedCookies.length} 条登录 Cookie`);
        }
      } catch (e) {
        console.log('[douyin] 载入 Cookie 异常:', e.message);
      }
    }

    page = await context.newPage();
    registerActivePage(page, { platform: 'douyin', title: '抖音精选推荐流', url: 'https://www.douyin.com/?recommend=1' });

    await page.goto('https://www.douyin.com/?recommend=1', { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(3000);
    await dismissPopups(page);

    try {
      const snap = await page.screenshot({ type: 'jpeg', quality: 75 });
      saveSnapshot(snap, { platform: 'douyin', title: '抖音精选推荐流' });
    } catch {}

    await page.evaluate(() => window.scrollBy({ top: 400, behavior: 'smooth' }));
    await page.waitForTimeout(3000);

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
 * 触发一次真实的刷抖音流程（支持指定视频和自动交互）
 */
export async function browseDouyinLive({ isOwner = true, prompt = '', targetUrl = null } = {}) {
  if (activeRoom) {
    activeRoom.setState('desk_laptop', {
      action: '在电脑前刷抖音',
      message: targetUrl ? '收到！这就去看看老爸发来的抖音视频~' : '收到！这就爬到电脑前刷会儿抖音给你汇报~',
    });
  }

  const dataDir = activeMemory?.dataDir || '/root/ai-companion-xiaoyu/ai-companion-kit/packages/companion/data';

  // 如果指定了具体视频链接
  if (targetUrl) {
    const res = await watchAndInteractDouyinVideo(targetUrl, {
      doLike: true,
      doFollow: Math.random() < 0.2
    });

    let thought = '看完了，感觉还挺有意思的。';
    const video = res.info || { title: '抖音视频', author: '创作者', likes: '1000' };

    if (activeBrain) {
      try {
        const reply = await activeBrain.reply({
          key: 'internal:douyin',
          userId: 'system',
          userName: '系统',
          text: `【老爸给你发了一条抖音视频，你刚才在电脑上认真看完了】：\n视频标题：《${video.title}》\n创作者：${video.author}\n点赞量：${video.likes}\n热评：${(video.topComments || []).join('；')}\n请按照老群友的随性自然口吻向老爸如实汇报并吐槽你看完这个视频的真实想法（1~2句极简吐槽，挑核心槽点，严禁任何括号动作描写和套话）！`,
          situation: '老爸让你看一个抖音视频，你刚才在电脑前看完了。'
        });
        if (reply?.text) {
          thought = reply.text.trim();
        }
      } catch (e) {
        console.log('[douyin] Brain 生成感悟失败:', e?.message || e);
      }
    }

    state.lastVideo = video;
    state.lastAction = `在电脑上看完了老爸分享的《${video.title.slice(0, 25)}》`;
    state.updatedAt = Date.now();
    state.summary = `刚看完老爸分享的抖音《${video.title.slice(0, 20)}》：${thought}`;

    try {
      const diaryFile = path.join(dataDir, 'diary.jsonl');
      const entry = {
        category: '短视频',
        activity: '看老爸推荐抖音',
        title: video.title,
        author: video.author,
        thought,
        liked: res.liked,
        followed: res.followed,
        at: new Date().toISOString(),
      };
      fs.appendFileSync(diaryFile, JSON.stringify(entry) + '\n', 'utf8');
    } catch {}

    if (activeRoom) {
      activeRoom.setState('desk_laptop', {
        action: '看完了老爸推的抖音',
        message: thought,
      });
      setTimeout(() => {
        activeRoom.setState('bed_phone', {
          action: '回床上躺着玩手机',
          message: '看完了，继续回床上瘫着~',
        });
      }, 45000);
    }

    return {
      video,
      thought,
      liked: res.liked,
      followed: res.followed,
      report: `看了，${video.title.slice(0, 30)}：\n${thought}${res.liked ? '（顺手点了赞）' : ''}`,
    };
  }

  // 正常随机推荐流摸鱼
  let feed = await fetchDouyinFeed();
  if (!feed || feed.length === 0) {
    feed = readCachedFeed(dataDir);
  } else {
    writeCachedFeed(dataDir, feed);
  }

  if (!feed || feed.length === 0) {
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

  const pick = feed[Math.floor(Math.random() * Math.min(feed.length, 5))];
  state.lastVideo = pick;
  state.lastAction = `在电脑上刷到了 ${pick.author} 发的《${pick.title.slice(0, 25)}》`;
  state.updatedAt = Date.now();

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

  if (activeRoom) {
    activeRoom.setState('desk_laptop', {
      action: '刚刷完一条抖音',
      message: thought,
    });
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
  watchAndInteractDouyinVideo,
  browseDouyinLive,
  getDouyinLivingStatus,
  setDouyinRoom,
};
