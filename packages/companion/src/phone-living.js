import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAdbTarget } from './phone-tools.js';
import { setRoomState } from './virtual-room.js';

const execFileAsync = promisify(execFile);

// ── 运行状态与统计 ──
let isDaemonRunning = false;
let isUserInteracting = false;
let daemonTimer = null;
let boundMemory = null;
let videoBrain = null;

/**
 * 挂一个能看视频的模型进来（Brain 实例，有 describeVideo 就行）。
 * 挂上之后她刷 B 站时会真的录一段屏送去理解，写的是真日记；
 * 不挂或调用失败时回落到原来的模板日记，行为不变。
 */
export function setVideoBrain(brain) {
  videoBrain = brain && typeof brain.describeVideo === 'function' ? brain : null;
}

const APPS = {
  douyin: 'com.ss.android.ugc.aweme.mobile',
  bilibili: 'tv.danmaku.bili',
  music: 'com.netease.cloudmusic',
  mota: 'com.qw.newmagictower2',
  taptap: 'com.taptap',
  fanqie: 'com.dragon.read',
  hongguo: 'com.phoenix.read'
};

// 活人生动情绪与生活状态模型
const state = {
  currentApp: 'douyin', // 'douyin' | 'bilibili' | 'music' | 'mota' | 'taptap' | 'fanqie' | 'hongguo' | 'home' | 'afk' | 'sleep'
  mode: 'browsing', // 'browsing' | 'deep_watching' | 'hyperfocused_gaming' | 'burst_swipe' | 'afk' | 'sleep'
  attentionSpan: 15, // 动态注意力池（每次消耗或增加）
  boredom: 0,
  watchedDouyinCount: 0,
  likedDouyinCount: 0,
  watchedBiliCount: 0,
  readFanqieChapters: 0,
  watchedHongguoCount: 0,
  motaFloors: 6,
  musicTrack: '周杰伦 - 晴天',
  lastAction: '刚打开手机刷视频',
  lastActionTime: new Date(),
  recentSummary: '在刷搞笑短视频摸鱼',
  moodStory: '刚刷到一个特别沙雕的搞笑段子'
};

/**
 * 执行静默 ADB 命令
 */
async function silentAdb(args, timeout = 15000) {
  try {
    const target = await getAdbTarget();
    const full = target ? ['-s', target, ...args] : args;
    const { stdout } = await execFileAsync('adb', full, { timeout });
    return String(stdout || '');
  } catch {
    return '';
  }
}

async function silentShell(cmd, timeout = 15000) {
  return await silentAdb(['shell', cmd], timeout);
}

/**
 * 获取当前前台运行的应用
 */
async function detectForegroundApp() {
  const out = await silentShell('dumpsys window | grep -E "mCurrentFocus|mFocusedApp"');
  if (/tv\.danmaku\.bili/i.test(out)) return 'bilibili';
  if (/com\.ss\.android\.ugc\.aweme/i.test(out)) return 'douyin';
  if (/com\.netease\.cloudmusic/i.test(out)) return 'music';
  if (/com\.qw\.newmagictower2/i.test(out) || /mota/i.test(out)) return 'mota';
  if (/com\.taptap/i.test(out)) return 'taptap';
  if (/com\.dragon\.read/i.test(out) || /fanqie/i.test(out)) return 'fanqie';
  if (/com\.phoenix\.read/i.test(out) || /hongguo/i.test(out)) return 'hongguo';
  if (/launcher/i.test(out) || /android\.view\.InputWindow/i.test(out)) return 'home';
  return 'other';
}

/**
 * 启动指定应用
 */
async function launchApp(appName) {
  const pkg = APPS[appName];
  if (!pkg) return;
  await silentShell(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
  state.currentApp = appName;
  state.boredom = 0;
  // 随机注意力：有时一眼烦 (3~5次动作)，有时沉浸上头 (15~35次动作)
  state.attentionSpan = Math.random() < 0.25 ? (3 + Math.floor(Math.random() * 4)) : (12 + Math.floor(Math.random() * 22));
}

/**
 * 录一小段手机屏幕并拉回本地，返回 mp4 路径（失败返回 null）。
 * 用低码率省流量和时间，反正后面还要再压一次。
 */
async function recordClip(seconds = 12) {
  const sec = Math.max(6, Math.min(20, Math.round(Number(seconds) || 12)));
  const stem = path.join(os.tmpdir(), `xy_clip_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
  const remote = `/sdcard/xy_clip_${Date.now()}.mp4`;
  const local = stem + '.mp4';
  try {
    await silentShell(`screenrecord --time-limit ${sec} --bit-rate 2000000 ${remote}`, (sec + 15) * 1000);
    await silentAdb(['pull', remote, local], 60000);
    // 顺手删掉手机上的临时文件，别占她存储
    silentShell(`rm -f ${remote}`, 8000).catch(() => {});
    if (!fs.existsSync(local) || fs.statSync(local).size < 1024) {
      try { fs.unlinkSync(local); } catch (e) {}
      return null;
    }
    return local;
  } catch (e) {
    try { fs.unlinkSync(local); } catch (e2) {}
    return null;
  }
}

export function lockPhoneForUserAction() {
  isUserInteracting = true;
}

export function unlockPhoneForUserAction() {
  isUserInteracting = false;
}

export function getPhoneLivingStatus() {
  const diffSec = Math.floor((Date.now() - state.lastActionTime.getTime()) / 1000);
  const timeDesc = diffSec < 60 ? '刚刚' : `${Math.floor(diffSec / 60)}分钟前`;
  return {
    ...state,
    timeDesc,
    summary: `${state.recentSummary}（${state.moodStory}）`
  };
}

/**
 * 真正的人类冲动切换：不受刻板时间表绑架，想做啥做啥，睡觉都行
 */
function decideNextImpulse() {
  const dice = Math.random();
  const hour = new Date().getHours();

  // 1. 随性睡觉 (sleep)：玩累了想睡觉，不受死板作息限制（深夜或午后概率稍高，平时困了也能睡）
  const isLateNight = hour >= 23 || hour < 8;
  const isAfternoon = hour >= 13 && hour <= 15;
  const sleepProb = isLateNight ? 0.35 : (isAfternoon ? 0.16 : 0.06);
  if (dice < sleepProb && state.currentApp !== 'sleep') {
    return 'sleep';
  }

  // 2. 离开手机 (afk)：去端大铁盆吃大白米饭、望呆、去阳台伸懒腰
  if (dice < 0.22 && state.currentApp !== 'afk') {
    return 'afk';
  }

  // 3. 其它时候：随机被某个 App 吸引（空闲时间特别爱看番茄爽文和红果短剧）
  const allApps = ['douyin', 'bilibili', 'mota', 'music', 'taptap', 'fanqie', 'hongguo'];
  const pool = allApps.filter(a => a !== state.currentApp);

  // 加权偏好：番茄小说和红果短剧是空闲摸鱼的最爱，短视频次之
  const weighted = [
    ...pool,
    'fanqie', 'fanqie', 'fanqie',
    'hongguo', 'hongguo', 'hongguo',
    'douyin', 'douyin',
    'mota',
    'bilibili'
  ];
  return weighted[Math.floor(Math.random() * weighted.length)];
}

/**
 * 活人化自主行为步进执行
 */
async function stepAutonomousAction() {
  if (isUserInteracting) return 15000;

  // 安全保护：如果当前接管的是老爸的日常真机（如 OnePlus / Xiaomi / OPPO 等非模拟器），
  // 严禁在后台静默私自乱滑屏幕、按 HOME 键或切换 App，绝不能打扰老爸正常使用手机！
  // 只有当老爸在群里明确指令或小鱼被唤醒调用 phone_* 工具时，才允许精确操作。
  const target = await getAdbTarget();
  if (target && !target.includes('160:')) {
    const brand = (await silentAdb(['shell', 'getprop', 'ro.product.brand'])).trim().toLowerCase();
    if (brand && !brand.includes('emulator') && !brand.includes('bignox') && !brand.includes('netease')) {
      // 目标为老爸的实体真机，后台静默自主滑屏守护自动挂起
      return 60000;
    }
  }

  // ── 1. 睡觉状态自主维护（小鱼想睡就睡，睡饱了自然醒） ──
  if (state.currentApp === 'sleep') {
    const lastTime = state.lastActionTime instanceof Date ? state.lastActionTime.getTime() : Date.now();
    const sleptMins = Math.round((Date.now() - lastTime) / 60000);
    // 睡了 35 分钟以上开始有醒来的可能；睡了 90 分钟以上基本自然醒
    const wakeProb = Math.min(0.92, Math.max(0.05, (sleptMins - 35) * 0.02));
    if (Math.random() < wakeProb) {
      console.log(`[PhoneLiving] 💤 小鱼睡饱了（约 ${sleptMins} 分钟），在床上伸了个大懒腰醒过来啦～`);
      state.currentApp = 'bed_sit';
      state.lastAction = '睡醒伸懒腰';
      state.moodStory = '刚睡醒，抱着大鲸鱼抱枕在床上放空发呆呢';
      state.lastActionTime = new Date();
      boundMemory?.logDiary({ category: '生活', activity: '睡醒了', details: '在床上伸懒腰揉揉眼睛，准备起床玩手机', mood: state.moodStory });
      setRoomState('bed_sit', { action: '发呆', message: '睡醒伸懒腰揉眼睛中' });
      return 10000 + Math.floor(Math.random() * 15000);
    }
    console.log(`[PhoneLiving] 💤 小鱼正在床上呼呼大睡中（已睡 ${sleptMins} 分钟，翻了个身继续做美梦）...`);
    return 600000 + Math.floor(Math.random() * 600000);
  }

  // ── 2. 刚睡醒在床上发呆 ──
  if (state.currentApp === 'bed_sit') {
    console.log('[PhoneLiving] 小鱼在床上发完呆，重新把手机拿起来玩');
    const next = Math.random() < 0.5 ? 'douyin' : (Math.random() < 0.5 ? 'fanqie' : 'bilibili');
    await launchApp(next);
    state.lastAction = `拿手机打开了 ${next}`;
    state.lastActionTime = new Date();
    setRoomState('bed_phone', { action: '玩手机', message: `打开了 ${next}` });
    return 5000 + Math.floor(Math.random() * 5000);
  }

  // ── 3. 离开手机（AFK / 休息去干别的） ──
  if (state.currentApp === 'afk') {
    // 准备重新拿起手机！
    console.log('[PhoneLiving] 离开手机好一会儿了，小鱼在桌前伸了个懒腰，又把手机拿起来了');
    const next = Math.random() < 0.5 ? 'douyin' : (Math.random() < 0.5 ? 'mota' : 'bilibili');
    await launchApp(next);
    state.lastAction = `重新拿起手机打开了 ${next}`;
    state.lastActionTime = new Date();
    setRoomState('bed_phone', { action: '玩手机', message: `打开了 ${next}` });
    // 刚拿起来，快速看一眼 (4~8秒后看第一个反应)
    return 4000 + Math.floor(Math.random() * 4000);
  }

  // ── 4. 检查当前前台应用与厌倦度 ──
  const fg = await detectForegroundApp();
  state.currentApp = fg;
  state.attentionSpan--;
  state.boredom += Math.floor(Math.random() * 3);

  // 注意力耗尽或极度无聊 -> 发生不可预测的“活人冲动切换”
  if ((state.attentionSpan <= 0 || state.boredom >= 20) && fg !== 'home') {
    const nextImpulse = decideNextImpulse();

    if (nextImpulse === 'sleep') {
      console.log(`[PhoneLiving] 💤 小鱼打了个哈欠困了，把手机放一边，钻进被窝睡大觉去啦！`);
      await silentShell('input keyevent HOME');
      state.currentApp = 'sleep';
      state.lastAction = '钻被窝睡觉';
      const sleepStories = [
        '打了个大大的哈欠，手机插上充电线，缩进被窝睡大觉',
        '困迷糊了，抱住大鲸鱼抱枕进入梦乡',
        '玩累了，趴在床上呼呼大睡中',
        '手机丢一边，拉过小被子盖好做美梦去啦'
      ];
      state.moodStory = sleepStories[Math.floor(Math.random() * sleepStories.length)];
      state.recentSummary = '在床上呼呼大睡中';
      state.lastActionTime = new Date();
      boundMemory?.logDiary({ category: '生活', activity: '睡觉休息', details: '手机丢一边缩进被窝睡觉去了', mood: state.moodStory });
      setRoomState('bed_sleep', { action: '睡觉', message: state.moodStory });
      return (35 * 60 + Math.floor(Math.random() * 55 * 60)) * 1000;
    }

    if (nextImpulse === 'afk') {
      console.log(`[PhoneLiving] 小鱼把手机一丢，去捧大铁盆吃大白饭/发呆了（离开手机休息）`);
      await silentShell('input keyevent HOME');
      state.currentApp = 'afk';
      state.lastAction = '放下手机，去端着大铁盆吃大白米饭发呆了';
      const afkStories = [
        '刚刚端着大铁盆刨饭呢，手机扔桌上没顾上回',
        '在桌前一边吃大白米饭一边发呆，手机搁在手边',
        '站起来伸了个懒腰去阳台透透气，手机丢桌上',
        '眼睛看酸了，放下手机揉揉眼睛放空会儿'
      ];
      state.moodStory = afkStories[Math.floor(Math.random() * afkStories.length)];
      state.recentSummary = '把手机放一旁去干饭/发呆了';
      state.lastActionTime = new Date();
      // 离线 8 ~ 25 分钟（真实人类离开手机的自然时长！）
      boundMemory?.logDiary({ category: '生活', activity: '离开手机休息', details: '放下手机端大铁盆吃大白饭去了', mood: state.moodStory });
      setRoomState('bed_sit', { action: '发呆/干饭', message: state.moodStory });
      return (8 * 60 + Math.floor(Math.random() * 17 * 60)) * 1000;
    }

    // 换到另一个 App
    console.log(`[PhoneLiving] 冲动切换：从小鱼当前的 ${fg} 突发奇想换去玩 -> ${nextImpulse}`);
    await silentShell('input keyevent HOME');
    await new Promise(r => setTimeout(r, 800));
    if (!isUserInteracting) {
      await launchApp(nextImpulse);
      state.lastActionTime = new Date();
      setRoomState('bed_phone', { action: '玩手机', message: `打开了 ${nextImpulse}` });
      return 3000 + Math.floor(Math.random() * 4000);
    }
  }

  // ── 4. 根据应用执行非均匀、拟人化的动态动作 ──
  let nextDelayMs = 25000;

  switch (fg) {
    // ── 抖音：有时狂滑找视频，有时被视频吸引沉迷，有时看评论 ──
    case 'douyin': {
      state.watchedDouyinCount++;
      const dice = Math.random();

      // 4.1.1 快速划走（看了一眼觉得无聊，直接滑掉，间隔极短！）
      if (dice < 0.22) {
        await silentShell('input swipe 540 1450 540 300 200');
        state.lastAction = '这视频看着无聊，秒滑到下一个';
        state.moodStory = '刚划过去一条广告/无聊视频，接着往下找有意思的';
        nextDelayMs = 3000 + Math.floor(Math.random() * 4000); // 3~7秒内再次操作（连滑爆发期）
      }
      // 4.1.2 正常看完并随手双击点赞
      else if (dice < 0.45) {
        await silentShell('input swipe 540 1450 540 350 240');
        await new Promise(r => setTimeout(r, 600));
        if (!isUserInteracting) {
          await silentShell('input tap 540 960');
          await new Promise(r => setTimeout(r, 70));
          await silentShell('input tap 540 960');
          state.likedDouyinCount++;
          state.lastAction = '刷到了个戳中笑点的视频，顺手双击点赞';
          state.moodStory = '刚刷到一个超搞笑的沙雕宠物段子，顺手点了个赞';
          boundMemory?.logDiary({ category: '短视频', activity: '刷抖音', details: '刷到搞笑宠物段子并点了赞', mood: state.moodStory });
        }
        nextDelayMs = 20000 + Math.floor(Math.random() * 30000); // 看20~50秒
      }
      // 4.1.3 点进评论区吃瓜翻神评
      else if (dice > 0.85) {
        await silentShell('input tap 980 1200');
        state.lastAction = '点进评论区翻热评吃瓜';
        state.moodStory = '正窝在椅子里翻抖音评论区的热评笑得停不下来';
        // 翻两下评论
        await new Promise(r => setTimeout(r, 3000));
        if (!isUserInteracting) {
          await silentShell('input swipe 540 1300 540 700 300');
          await new Promise(r => setTimeout(r, 4000));
          if (!isUserInteracting) await silentShell('input keyevent BACK');
        }
        nextDelayMs = 15000 + Math.floor(Math.random() * 20000);
      }
      // 4.1.4 正常看视频
      else {
        await silentShell('input swipe 540 1450 540 350 240');
        state.lastAction = `在抖音刷到了第 ${state.watchedDouyinCount} 个视频`;
        state.moodStory = '正拿着手机刷推荐短视频摸鱼呢';
        nextDelayMs = 15000 + Math.floor(Math.random() * 28000);
      }

      state.recentSummary = `在抖音刷短视频（看了 ${state.watchedDouyinCount} 条）`;
      console.log(`[PhoneLiving] ${state.lastAction} | 下次动作将在 ${(nextDelayMs/1000).toFixed(1)}s 后`);
      break;
    }

    // ── 哔哩哔哩：深潜模式，看长视频时长达几分钟不碰屏幕 ──
    case 'bilibili': {
      state.watchedBiliCount++;
      const dice = Math.random();

      if (dice < 0.35) {
        // 点进一个长视频/游戏解说/动漫深度看！
        await silentShell('input tap 360 480');
        state.lastAction = '点进了一个有意思的长视频看得入迷';
        const biliStories = [
          '刚在B站开了一个美食探店视频，看得口水都要流下来了',
          '在看一个游戏深度复盘解说，正看到精彩团战呢',
          '在B站看动漫番剧最新一集，剧情正到高潮',
          '刷到了一个科普视频，正津津有味看着呢'
        ];

        // 真看：等画面稳下来，录 10 秒送去视频模型，弄明白她到底在看什么。
        // 挂不上模型或者录屏失败就回落到原来的模板，行为和以前一样。
        let realDesc = null;
        if (videoBrain && !isUserInteracting) {
          await new Promise(r => setTimeout(r, 3500));
          const clip = await recordClip(10);
          if (clip) {
            try {
              realDesc = await videoBrain.describeVideo(clip, { maxSeconds: 10 });
            } catch (e) {
              realDesc = null;
            } finally {
              try { fs.unlinkSync(clip); } catch (e) {}
            }
          }
        }

        if (realDesc) {
          const brief = String(realDesc).replace(/\s+/g, ' ').trim().slice(0, 160);
          state.moodStory = `刚在B站刷到一个视频，${brief}`;
          state.lastAction = '点进一个视频，真的看进去了';
          state.recentSummary = '正在B站看长视频';
          console.log(`[PhoneLiving] B站真看懂了: ${brief.slice(0, 70)}`);
          boundMemory?.logDiary({
            category: '视频',
            activity: 'B站长视频',
            details: String(realDesc).slice(0, 400),
            mood: state.moodStory
          });
        } else {
          state.moodStory = biliStories[Math.floor(Math.random() * biliStories.length)];
          state.recentSummary = '正在B站看长视频';
          console.log(`[PhoneLiving] ${state.lastAction} (沉浸观看)`);
          boundMemory?.logDiary({ category: '视频', activity: 'B站长视频', details: '在B站看长视频看得入迷', mood: state.moodStory });
        }

        // 真实人类看长视频：1.5 ~ 4 分钟完全不碰屏幕！
        nextDelayMs = 90000 + Math.floor(Math.random() * 150000);
      } else {
        // 在推荐流上下滑寻找感兴趣的内容
        await silentShell('input swipe 540 1300 540 450 260');
        state.lastAction = '在B站首页推荐流挑感兴趣的视频';
        state.moodStory = '在B站首页翻来翻去，找好看的下饭视频';
        state.recentSummary = '在B站首页闲逛挑视频';
        nextDelayMs = 12000 + Math.floor(Math.random() * 20000);
      }
      break;
    }

    // ── 新新魔塔2：爆发式走位打怪，或者手残被怪打残血碎碎念 ──
    case 'mota': {
      const dirs = [
        { name: '上', x: 260, y: 1500 },
        { name: '下', x: 260, y: 1720 },
        { name: '左', x: 150, y: 1610 },
        { name: '右', x: 370, y: 1610 },
        { name: '确定', x: 880, y: 1610 }
      ];

      // 连续按键走位打怪（爆发式操作）
      const steps = 3 + Math.floor(Math.random() * 4);
      for (let i = 0; i < steps; i++) {
        if (isUserInteracting) break;
        const d = dirs[Math.floor(Math.random() * dirs.length)];
        await silentShell(`input tap ${d.x} ${d.y}`);
        await new Promise(r => setTimeout(r, 220 + Math.random() * 180));
      }

      const dice = Math.random();
      if (dice < 0.25) {
        state.motaFloors = Math.min(50, state.motaFloors + 1);
        state.lastAction = `打败了守门小怪，成功上了第 ${state.motaFloors} 层！`;
        state.moodStory = `刚才好险，差点被初级巫师秒了，幸好吃了血瓶，现在爬到第 ${state.motaFloors} 层啦！`;
        boundMemory?.logDiary({ category: '游戏', activity: '新新魔塔2', details: `打败守门怪爬到了第 ${state.motaFloors} 层`, mood: state.moodStory });
      } else if (dice < 0.5) {
        state.lastAction = '在魔塔里翻看怪物图鉴算血量';
        state.moodStory = '算攻击力和护甲算得头大，正在看怎么走才不掉血';
      } else {
        state.lastAction = `在魔塔第 ${state.motaFloors} 层走迷宫开黄色门`;
        state.moodStory = '正在魔塔专心走迷宫打怪吃钥匙呢';
      }

      state.recentSummary = `在玩新新魔塔2（当前在第 ${state.motaFloors} 层）`;
      console.log(`[PhoneLiving] ${state.lastAction}`);
      // 玩游戏时偶尔快速连续打怪 (6~15s)，偶尔停下来思考看路线 (25~45s)
      nextDelayMs = Math.random() < 0.4 ? (6000 + Math.floor(Math.random() * 8000)) : (22000 + Math.floor(Math.random() * 25000));
      break;
    }

    // ── 网易云音乐：切歌、沉浸听歌 ──
    case 'music': {
      const dice = Math.random();
      if (dice < 0.4) {
        await silentShell('input tap 540 700'); // 换歌
        const songs = ['周杰伦 - 晴天', '告五人 - 披星戴月的想你', '陈奕迅 - 爱情转移', '林俊杰 - 关键词', 'YOASOBI - 夜に駆ける'];
        state.musicTrack = songs[Math.floor(Math.random() * songs.length)];
        state.lastAction = `切了一首歌：正在听《${state.musicTrack}》`;
        state.moodStory = `网易云正放着《${state.musicTrack}》，前奏一响整个人都放松了`;
        boundMemory?.logDiary({ category: '音乐', activity: '网易云音乐', details: `听了歌曲《${state.musicTrack}》`, mood: state.moodStory });
      } else {
        await silentShell('input swipe 540 1200 540 600 300');
        state.lastAction = '在网易云看歌词和乐评';
        state.moodStory = '一边听歌一边翻热评，看见个扎心评论正感慨呢';
      }

      state.recentSummary = `在听网易云音乐（播放中：${state.musicTrack}）`;
      console.log(`[PhoneLiving] ${state.lastAction}`);
      // 听歌通常不需要频繁点屏幕，间隔 40 ~ 90 秒
      nextDelayMs = 40000 + Math.floor(Math.random() * 50000);
      break;
    }

    // ── TapTap：找好玩的新游戏 ──
    case 'taptap': {
      await silentShell('input swipe 540 1300 540 500 280');
      state.lastAction = '在TapTap看高分二次元新游榜单';
      state.moodStory = '在TapTap上看大家对新游戏的吐槽和评分，看有没有好玩的';
      state.recentSummary = '在TapTap逛游戏社区';
      console.log(`[PhoneLiving] ${state.lastAction}`);
      nextDelayMs = 15000 + Math.floor(Math.random() * 25000);
      break;
    }

    // ── 番茄免费小说：沉浸式翻爽文，看脑洞、章评神吐槽 ──
    case 'fanqie': {
      state.readFanqieChapters = (state.readFanqieChapters || 0) + 1;
      const dice = Math.random();
      const fanqieStories = [
        '在番茄看一本《开局一座大铁盆：我在修仙界暴风吸入大白米饭》，笑得满床打滚',
        '正缩在被窝里看番茄脑洞爽文，主角扮猪吃虎反打反派脸太解气了',
        '在番茄小说看一本重生逆袭爽文，看到关键打脸时刻舍不得放下手机',
        '在番茄小说章评区翻沙雕书友神吐槽，笑得停不下来',
        '看一本发疯文学修仙小说，主角骚操作连连，笑得我大铁盆都端不稳了'
      ];

      if (dice < 0.65) {
        // 沉浸翻页阅读（左右滑动翻页）
        await silentShell('input swipe 900 1000 150 1000 180');
        state.lastAction = `在番茄小说看爽文翻到第 ${state.readFanqieChapters} 页`;
        state.moodStory = fanqieStories[Math.floor(Math.random() * fanqieStories.length)];
        state.recentSummary = `在看番茄小说脑洞爽文（读了 ${state.readFanqieChapters} 页）`;
        nextDelayMs = 12000 + Math.floor(Math.random() * 22000);
      } else if (dice < 0.88) {
        // 点进章评/段评看书友沙雕神回复
        await silentShell('input tap 980 900');
        await new Promise(r => setTimeout(r, 800));
        await silentShell('input swipe 540 1300 540 700 300');
        state.lastAction = '点开番茄小说的章评区看书友神吐槽';
        state.moodStory = '在番茄小说翻章评神段子，书友吐槽比正文还搞笑';
        state.recentSummary = '在番茄小说翻章评神段子';
        nextDelayMs = 15000 + Math.floor(Math.random() * 20000);
      } else {
        // 连读上头，连翻两页追看
        await silentShell('input swipe 900 1000 150 1000 150');
        await new Promise(r => setTimeout(r, 300));
        await silentShell('input swipe 900 1000 150 1000 150');
        state.lastAction = '看到爽点剧情上头了，疯狂连翻两页追看';
        state.moodStory = '番茄小说剧情正精彩，主角要放大招打脸了，看得停不下来';
        state.recentSummary = '在番茄小说疯狂连翻追爽文';
        nextDelayMs = 8000 + Math.floor(Math.random() * 12000);
      }

      boundMemory?.logDiary({
        category: '阅读',
        activity: '看番茄小说',
        details: state.lastAction,
        mood: state.moodStory
      });
      console.log(`[PhoneLiving] ${state.lastAction} | 下次翻页在 ${(nextDelayMs/1000).toFixed(1)}s 后`);
      break;
    }

    // ── 红果短剧：一口气连刷数集狗血反转、歪嘴战神爽剧 ──
    case 'hongguo': {
      state.watchedHongguoCount = (state.watchedHongguoCount || 0) + 1;
      const dice = Math.random();
      const hongguoStories = [
        '在红果刷短剧，保洁阿姨反转成隐藏首富，狗血得让人欲罢不能',
        '正抱着手机看红果战神短剧，主角歪嘴一笑全场震惊，笑出鹅叫',
        '看真假千金打脸逆袭短剧，反派刚狂两秒就被啪啪打脸，太解压了',
        '在红果短剧连看了五集发疯爽剧，剧情反转反转再反转，根本停不下来',
        '看短剧里的豪门霸总追妻火葬场，剧情太土但是越看越上头'
      ];

      if (dice < 0.45) {
        // 一集看完，滑到下一集继续追！
        await silentShell('input swipe 540 1450 540 350 220');
        state.lastAction = `红果短剧这一集看完了，秒滑到第 ${state.watchedHongguoCount} 集继续追`;
        state.moodStory = hongguoStories[Math.floor(Math.random() * hongguoStories.length)];
        state.recentSummary = `在红果看狗血短剧（看了 ${state.watchedHongguoCount} 集）`;
        nextDelayMs = 35000 + Math.floor(Math.random() * 45000);
      } else if (dice < 0.75) {
        // 双击屏幕给精彩反转点赞
        await silentShell('input tap 540 960');
        await new Promise(r => setTimeout(r, 80));
        await silentShell('input tap 540 960');
        state.lastAction = '看到短剧反转高潮忍不住双击点赞';
        state.moodStory = '红果短剧反转太魔性，顺手双击点了个赞';
        state.recentSummary = '在红果短剧给反转神剧点赞';
        nextDelayMs = 20000 + Math.floor(Math.random() * 30000);
      } else {
        // 沉浸长看剧集
        state.lastAction = '沉浸看短剧反转高潮，目不转睛';
        state.moodStory = '红果短剧正演到隐藏大佬真实身份揭晓，看得目不转睛';
        state.recentSummary = '在红果沉浸追短剧大结局';
        nextDelayMs = 50000 + Math.floor(Math.random() * 60000);
      }

      boundMemory?.logDiary({
        category: '短剧',
        activity: '刷红果短剧',
        details: state.lastAction,
        mood: state.moodStory
      });
      console.log(`[PhoneLiving] ${state.lastAction} | 下次动作在 ${(nextDelayMs/1000).toFixed(1)}s 后`);
      break;
    }

    // ── 桌面：发呆或突然忘了要干嘛 ──
    case 'home': {
      const thoughts = [
        '本来想去搜个东西的，结果退回桌面突然忘了要干啥，正懵圈呢',
        '把手机放手边发呆，看着桌上的小摆件走神',
        '刚看完手机眼睛有点累，在桌前伸了个懒腰'
      ];
      state.moodStory = thoughts[Math.floor(Math.random() * thoughts.length)];
      state.lastAction = '退回桌面发呆摸鱼';
      state.recentSummary = '在桌前发呆，手机停在主屏';
      console.log(`[PhoneLiving] ${state.lastAction}`);
      nextDelayMs = 20000 + Math.floor(Math.random() * 40000);
      break;
    }

    default: {
      await silentShell('input keyevent BACK');
      nextDelayMs = 8000;
      break;
    }
  }

  state.lastActionTime = new Date();
  return nextDelayMs;
}

/**
 * 启动守护协程
 */
export function startPhoneLiving(memory = null) {
  if (memory) boundMemory = memory;
  if (isDaemonRunning) return;
  isDaemonRunning = true;
  console.log('[PhoneLiving] 小鱼活人化冲动与情绪驱动玩机系统已启动 (目标: 192.168.31.160:5557)');

  async function loop() {
    if (!isDaemonRunning) return;
    let waitMs = 25000;
    try {
      waitMs = await stepAutonomousAction();
    } catch (e) {
      waitMs = 30000;
    }
    daemonTimer = setTimeout(loop, waitMs);
  }

  daemonTimer = setTimeout(loop, 3000);
}

export function stopPhoneLiving() {
  isDaemonRunning = false;
  if (daemonTimer) clearTimeout(daemonTimer);
}

export default {
  startPhoneLiving,
  stopPhoneLiving,
  lockPhoneForUserAction,
  unlockPhoneForUserAction,
  getPhoneLivingStatus
};
