/**
 * 小鱼游戏前台自主托管代玩系统 (Game Autopilot)
 * ─────────────────────────────────────────────────────────────
 * 1. 当老爸在聊天中明确指令“你来玩吧 / 帮我打这把 / 开启托管 / 托管”时激活；
 * 2. 绝对安全防误触准则：
 *    - 步进前严格检测当前顶层 Activity；
 *    - 只有在前台确定为支持的游戏（如云顶之弈 TFT / 金铲铲）时才允许操作；
 *    - 一旦检测到老爸按 HOME 退回桌面、切换到微信/QQ 或息屏，立即自动休眠退出，绝不打扰老爸；
 * 3. 仿生自主游戏闭环（每隔 6~10 秒步进一轮）：
 *    - 视觉看屏 ➔ 阶段判断 ➔ 工具操作（phone_tap / phone_drag） ➔ 关键战况截图汇报；
 * 4. 收到老爸“停 / 别玩了 / 我自己来”立即无条件退出。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { captureScreenBase64, getAdbTarget, getDisplayMetrics } from './phone-tools.js';

const execFileAsync = promisify(execFile);

// 支持自动识别的游戏关键词
const GAME_KEYWORDS = [
  'teamfighttactics',
  'riotgames',
  'epicgames',
  'com.tencent.tft',
  'gameactivity',
  'tft'
];

export class GameAutopilot {
  constructor() {
    this.running = false;
    this.sessionKey = null;
    this.ownerId = null;
    this.timer = null;
    this.roundCount = 0;
    this.brain = null;
    this.bot = null;
    this.lastNotifyRound = 0;
  }

  init({ brain, bot }) {
    this.brain = brain;
    this.bot = bot;
  }

  isActive() {
    return this.running;
  }

  /**
   * 检查前台应用是否为游戏
   */
  async checkForegroundGame() {
    try {
      const target = await getAdbTarget();
      const { stdout } = await execFileAsync('adb', ['-s', target, 'shell', 'dumpsys', 'window'], { timeout: 4000 });
      const focusLine = (stdout.match(/mCurrentFocus=Window\{[^\r\n]+/i) || [])[0] || '';
      const focusedApp = (stdout.match(/mFocusedApp=ActivityRecord\{[^\r\n]+/i) || [])[0] || '';
      const combined = `${focusLine} ${focusedApp}`.toLowerCase();

      // 如果检测到回到桌面、锁屏或通信社交应用，坚决判定为离开游戏
      if (/launcher|keyguard|tencent\.mm|tencent\.mobileqq|systemui|inputwindow/i.test(combined)) {
        return { isGame: false, appName: 'system_or_social', raw: combined };
      }

      const isGame = GAME_KEYWORDS.some((kw) => combined.includes(kw));
      return { isGame, appName: isGame ? 'TFT_Game' : 'other', raw: combined };
    } catch (e) {
      return { isGame: false, error: e.message };
    }
  }

  /**
   * 开启游戏前台托管
   */
  async start({ sessionKey, ownerId, initialText = '' } = {}) {
    if (this.running) {
      return { ok: false, message: '已经在代玩托管中啦！' };
    }

    const fg = await this.checkForegroundGame();
    if (!fg.isGame) {
      return {
        ok: false,
        message: '老爸，我瞄了一眼手机，现在前台没打开云顶之弈哦！你先在手机上点开游戏，再叫我接手代打~'
      };
    }

    this.running = true;
    this.sessionKey = sessionKey;
    this.ownerId = ownerId;
    this.roundCount = 0;
    this.lastNotifyRound = 0;

    console.log(`[GameAutopilot] ★ 游戏前台托管已启动！会话: ${sessionKey}`);
    this.scheduleNext(1500);

    return {
      ok: true,
      message: '好嘞老爸！小鱼代打正式上线，我已经接管前台云顶啦！\n你把手机放那就行，我每隔几秒自己看自己动；只要你切出游戏或者说一声“停”，我随时交还控制权！'
    };
  }

  /**
   * 停止托管
   */
  stop(reason = '用户主动要求停止') {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    console.log(`[GameAutopilot] 托管已停止：${reason}`);
    if (this.bot && this.sessionKey) {
      this.bot.send(this.sessionKey, `【小鱼交还控制权】：${reason}，老爸你自己接手玩吧~`).catch(() => {});
    }
  }

  /**
   * 调度下一轮循环
   */
  scheduleNext(delayMs) {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.step(), delayMs);
  }

  /**
   * 单步自主思考与操作
   */
  async step() {
    if (!this.running) return;

    // 1. 安全第一：前台有效性检查
    const fg = await this.checkForegroundGame();
    if (!fg.isGame) {
      this.stop('检测到你切出游戏退到桌面或打开了其他App，小鱼已自动休眠退出托管');
      return;
    }

    this.roundCount++;
    console.log(`[GameAutopilot] 正在执行第 ${this.roundCount} 轮自主代玩决策...`);

    try {
      const metrics = await getDisplayMetrics();
      const prompt = `【小鱼云顶之弈自主代玩系统·第 ${this.roundCount} 轮决策】：
当前设备：老爸的一加真机 (横屏逻辑分辨率: ${metrics.width}x${metrics.height})
当前状态：你正在前台全屏自主代玩《云顶之弈/自走棋》！

【核心任务与行动准则】：
1. 首先调用 phone_get_screen 查看当前最新战况与界面！
2. 根据画面自决行动：
   - 【大厅 / 模式选择】：点击右下角【开始游戏/寻找对局】（phone_tap 右下角 x: 0.85, y: 0.88）；
   - 【对局备战期】：
     * 如果商店有契合体系的棋子，调用 phone_tap 点击卡牌购买；
     * 如果备战席有棋子需要上场，调用 phone_drag(from_x, from_y, to_x, to_y) 从备战席长按拖到棋盘；
     * 如果左侧有散件/成装，调用 phone_drag 拖给主力英雄；
     * 如果金币充裕，可点升级人口或刷新；
   - 【对局战斗期】：战斗进行中无需盲目密集操作，可静观战局；
   - 【选秀期】：点击目标棋子/装备走位拾取；
3. 战况汇报：
   - 每隔 3~5 轮（或遇到升二星、合成神装、关键胜负等精彩瞬间），可调用 phone_send_screenshot_to_chat 顺便甩张截图给老爸看！
   - 用可爱老群友/贴心闺女语气简短汇报一两句（例如“刚合了两星前排顶住了”、“老爸我吃连胜了”），不用长篇大论。`;

      if (this.brain) {
        const res = await this.brain.reply({
          key: this.sessionKey,
          userId: this.ownerId || '578021239',
          userName: '老爸',
          text: '【系统指令：执行自主代玩循环】',
          situation: prompt,
          tools: true
        });

        // 如果模型生成了有趣吐槽或截图，且距上次通知超过 2 轮（或首轮/含截图），发给老爸
        const hasImage = res?.text && res.text.includes('[CQ:image');
        const shouldNotify = res?.text && (this.roundCount === 1 || hasImage || (this.roundCount - this.lastNotifyRound >= 3));
        if (shouldNotify) {
          const clean = res.text.replace(/【[^】]+】/g, '').trim();
          if (clean && this.bot && this.sessionKey) {
            this.bot.send(this.sessionKey, clean).catch(() => {});
            this.lastNotifyRound = this.roundCount;
          }
        }
      }
    } catch (e) {
      console.warn(`[GameAutopilot] 本轮决策异常：${e.message}`);
    }

    // 随机 6~11 秒后步入下一轮，模拟真人手速和思考间隙
    if (this.running) {
      const nextDelay = 6500 + Math.floor(Math.random() * 4500);
      this.scheduleNext(nextDelay);
    }
  }
}

export const gameAutopilot = new GameAutopilot();
export default gameAutopilot;
