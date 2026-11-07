/**
 * companion · 命令行入口
 * ─────────────────────────────────────────────────────────────
 * 把各层拼起来跑：
 *
 *   OneBot(收消息) → Waker(要不要醒) → Brain(生成回复)
 *                                        ↓
 *                                   Humanizer(怎么发)
 *                                        ↓
 *                                   OneBot(发消息)
 *
 * 用法：
 *   node src/index.js --config ./config.json
 *   node src/index.js --config ./config.json --dry-run   只打印，不真发
 *   node src/index.js --check                            只检查角色卡
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Memory } from './memory.js';
import { Role } from './role.js';
import { SelfPortrait } from './selfportrait.js';
import { Brain } from './brain.js';
import { Humanizer } from './humanize.js';
import { Waker } from './wake.js';
import { TopicFocusTracker } from './topic-focus.js';
import { OneBot } from './transport-onebot.js';
import { startPhoneLiving, getPhoneLivingStatus, setVideoBrain } from './phone-living.js';
import { startBiliLiving, recallKnowledge, expandVideoLink } from './bili-living.js';
import { startDouyinLiving, browseDouyinLive, getDouyinLivingStatus, setDouyinRoom } from './douyin-living.js';
import { startWebLiving, browseWebTopic, getWebLivingStatus, renderWebKnowledge } from './web-living.js';
import { startVirtualRoomServer, setRoomState } from './virtual-room.js';
import { startProactive } from './proactive.js';
import { collectFromSegs as collectStickers, pickSticker, readStickerBase64 } from './stickers.js';
import { Relationship } from './relationship.js';
import { ChatterLearner } from './chatter-learner.js';
import { initGrowth, observeIncoming, observeOwn, renderGrowth } from './growth.js';
import { initDesireEngine, renderDesirePrompt } from './desire-engine.js';
import { initImageGen } from './image-gen.js';
import { initGroupBridge, startOutboxWorker, setCurrentChat } from './group-bridge.js';
import { initDevChannel } from './dev-channel.js';
import { checkInput, checkOutput, cleanAllToolArtifacts } from './safety.js';
import { tarotDailyTick, tarotPromptBlock, tarotSummary } from './tarot-engine.js';
import { readVirtue, applyText as applyVirtueText, virtuePromptBlock } from './virtue-engine.js';
import { createRespectGuard } from './respect-guard.js';
import { classifyMessage } from './conversation-closure.js';
import { startDiaryScheduler } from './diary-system.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function appendBridgeLog(dataDir, line) {
  try {
    const f = path.join(dataDir || './data', 'bridge.log');
    const now = new Date();
    const timeStr = [now.getHours(), now.getMinutes(), now.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
    fs.appendFileSync(f, `${timeStr} [bridge] ${line}\n`, 'utf8');
  } catch {}
}

// ── 配置 ──────────────────────────────────────────────────────
export function loadConfig(explicitPath) {
  const file = explicitPath || path.join(__dirname, '..', 'config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { console.error('⚠️ 读不到 ' + file + '，用默认值（复制 config.example.json 改名即可）'); }
  const dir = path.dirname(path.resolve(file));
  const rel = (p, def) => (p ? path.resolve(dir, p) : path.join(dir, def));

  return {
    ...cfg,
    apiKey: cfg.apiKey || process.env.DEEPSEEK_API_KEY || '',
    baseUrl: cfg.baseUrl || 'https://api.deepseek.com/v1',
    model: cfg.model || 'deepseek-chat',

    roleCard: rel(cfg.roleCard, 'role.md'),
    roleMaxChars: cfg.roleMaxChars || 12000,
    dataDir: rel(cfg.dataDir, 'data'),
    bili: cfg.bili || {},
    vision: cfg.vision || null,
    videoVision: cfg.videoVision || null,

    onebot: {
      wsUrl: cfg.onebot?.wsUrl || 'ws://127.0.0.1:3001',
      httpUrl: cfg.onebot?.httpUrl || 'http://127.0.0.1:3000',
      accessToken: cfg.onebot?.accessToken || '',
    },

    names: cfg.names || [],
    keywords: cfg.keywords || [],
    ownerIds: (cfg.ownerIds || []).map(String),

    wake: {
      probability: cfg.wake?.probability ?? 0.05,
      groupAtOnly: cfg.wake?.groupAtOnly !== false,
      privateWindowMs: cfg.wake?.privateWindowMs ?? 1500,
      groupWindowMs: cfg.wake?.groupWindowMs ?? 2000,
      ...(cfg.wake || {}),
    },

    groupConfigs: cfg.groupConfigs || {},
    humanize: cfg.humanize || {},
    dryRun: process.argv.includes('--dry-run'),
  };
}

// ── 主程序 ────────────────────────────────────────────────────
// 群聊最近图片短期时空记忆环：记录群聊最近几分钟发过的图片，解决群友先发图、后发文字提问漏图的问题
const recentGroupImages = new Map();
const lastStickerSendTime = new Map(); // 记录每个会话上次发送表情包的时间，做频率与冷却控制

async function main() {
  const cfgIdx = process.argv.indexOf('--config');
  const cfg = loadConfig(cfgIdx >= 0 ? process.argv[cfgIdx + 1] : null);

  console.log('════════ companion ════════');
  console.log('  模型      ' + cfg.model + ' @ ' + cfg.baseUrl);
  console.log('  角色卡    ' + cfg.roleCard);
  console.log('  数据目录  ' + cfg.dataDir);
  console.log('  OneBot    ' + cfg.onebot.wsUrl);
  console.log('  名字      ' + (cfg.names.join(' / ') || '（没配）'));
  console.log('  主人      ' + (cfg.ownerIds.join(', ') || '（没配）'));
  console.log('  干跑      ' + (cfg.dryRun ? '是（不会真发）' : '否'));
  console.log('');

  const memory = new Memory({ dir: cfg.dataDir });
  const role = new Role({ cardPath: cfg.roleCard, altCardPath: cfg.roleCardSassy, selfImagePath: cfg.selfImageCard, selfImageAutoPath: cfg.selfImageAuto, maxChars: cfg.roleMaxChars });

  // 角色卡体检
  const lint = role.lint();
  if (!lint.ok) {
    console.log('⚠️ 角色卡检查：');
    lint.warn.forEach((w) => console.log('   · ' + w));
    console.log('');
  }
  if (process.argv.includes('--check')) { console.log('检查完毕。'); return; }
  if (!cfg.apiKey) console.log('⚠️ 没配 apiKey，模型调用会失败\n');

  const brain = new Brain({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, model: cfg.model, llmFallbacks: cfg.llmFallbacks, mainVision: cfg.mainVision, vision: cfg.vision, visionFallback: cfg.visionFallback, videoVision: cfg.videoVision,
    recall: recallKnowledge, role, memory, dataDir: cfg.dataDir });
  const human = new Humanizer(cfg.humanize);

  // 自我形象：看图生成自述 + 被要照片时发图
  const selfPortrait = new SelfPortrait({
    dir: cfg.selfPortraitDir || './assets/self',
    cachePath: (cfg.dataDir || './data') + '/self-portrait.json',
    brain,
  });
  selfPortrait.ensure().catch(() => {});
  const rel = new Relationship({ dir: cfg.dataDir || './data', enabled: cfg.relationship?.enabled !== false });
  const topicTracker = new TopicFocusTracker({
    focusWindowMs: cfg.wake?.topicFocusWindowMs ?? 180000,
    idleTimeoutMs: cfg.wake?.topicIdleTimeoutMs ?? 60000,
    microCooldownMs: cfg.wake?.topicMicroCooldownMs ?? 10000,
    maxTurnsPerFocus: cfg.wake?.topicMaxTurnsPerFocus ?? 6,
  });
  const respectGuard = createRespectGuard({
    file: path.join(cfg.dataDir || './data', 'respect.json'),
    ownerUin: cfg.ownerIds?.[0] || '578021239',
    log: console.log,
  });

  // 初始化当日牌灵与德行十轴
  tarotDailyTick(cfg.dataDir || './data', (m) => {
    console.log(m);
    appendBridgeLog(cfg.dataDir, m);
  });
  readVirtue(path.join(cfg.dataDir || './data', 'virtue.json'));
  appendBridgeLog(cfg.dataDir, `小鱼伴侣服务启动完成 (模型: ${cfg.model})`);

  const waker = new Waker({
    names: cfg.names,
    keywords: cfg.keywords,
    ownerIds: cfg.ownerIds,
    probability: cfg.wake.probability,
    batchWindowMs: cfg.wake.groupWindowMs,
    topicTracker,
  });

  // 启动时预先载入配置好的群聊策略
  if (cfg.groupConfigs) {
    for (const [gid, gcfg] of Object.entries(cfg.groupConfigs)) {
      const gkey = gid.startsWith('group:') ? gid : `group:${gid}`;
      waker.setConfig(gkey, {
        mode: 'diving',
        atMention: true,
        nameMention: true,
        question: false,
        poke: true,
        probability: 0.008,
        cooldownMs: 90000,
        ownerMustCall: true,
        ...gcfg,
      });
    }
  }

  // 群聊潜水自监督学习器：暗中观察人类群友说话习惯与最新梗，自动反思提炼
  const chatterLearner = new ChatterLearner({
    dataDir: cfg.dataDir || './data',
    brain,
    memory,
    minGapMs: 25 * 60 * 1000,
    msgThreshold: 30,
  });
  chatterLearner.start();

  // 成长记忆：群友对她的批评、表扬、特殊事件 → 自我认知
  initGrowth({ dataDir: cfg.dataDir || './data', cfg: cfg.growth, brain });
  initDesireEngine(cfg.dataDir || './data');

  // 生图：画出来、存本地、建索引，发不发由她自己判断
  // 余额告急时怎么喊人：bot 还没建，先用闭包占位，建好后自动接上
  let alertBot = null;
  initImageGen({
    dataDir: cfg.dataDir || './data',
    cfg: cfg.imageGen,
    // 余额告警交给 Hermes 的 cron 巡检（系统口吻），她这边只留日志
    notify: (msg) => console.log('[ImageGen] 余额告警（不发送，由 cron 巡检负责）：' + msg),
  });

  /** @type {Map<string, NodeJS.Timeout>} 每个会话的合并定时器 */
  const pending = new Map();

  const bot = new OneBot({
    ...cfg.onebot,
    dataDir: cfg.dataDir || './data',
    onMessage: (msg) => {
      // 群成员表：进群后第一次说话就拉一次，之后 6 小时才刷新
      if (msg.isGroup && msg.groupId) {
        bot.syncGroupMembers(msg.groupId)
          .then((r) => { if (r?.ok && !r.skipped) console.log(`   [OneBot] 群 ${msg.groupId} 成员表已同步 ${r.count} 人`); })
          .catch(() => {});
      }
      // 第一次见到这个会话 → 给个默认策略
      if (!waker.configs.has(msg.key)) {
        const gid = String(msg.groupId || (msg.key.startsWith('group:') ? msg.key.split(':')[1] : ''));
        const isSpicyGroup = gid === '1131460772';
        const groupSpecificCfg = cfg.groupConfigs?.[gid] || cfg.groupConfigs?.[msg.key];

        waker.setConfig(msg.key, msg.isGroup
          ? {
              mode: isSpicyGroup ? 'active' : 'diving',
              atMention: true,
              nameMention: true,
              question: isSpicyGroup, // 测试群开启问句，普通大群关闭泛问句抢答（对标牢大）
              poke: true,
              probability: isSpicyGroup ? 0.55 : (cfg.wake?.probability ?? 0.12),
              cooldownMs: isSpicyGroup ? 10000 : 90000, // 90秒发言冷却，完全对标牢大
              ownerMustCall: !isSpicyGroup, // 普通大群中老爸发言需叫名字/@才醒，闲聊不插嘴
              ...groupSpecificCfg,
            }
          : { mode: 'active', anyMessage: true, cooldownMs: 0 });   // 私聊每条都理
      }

      // 潜水记忆：无论小鱼此刻回不回复，群聊消息都滚动沉淀入环境背景记忆
      if (msg.isGroup) {
        memory.logGroupChatter({ groupKey: msg.key, userId: msg.userId, name: msg.name, text: msg.text });
        memory.touch(msg.userId, { name: msg.name });
        // 先看这条是不是在骂她；骂她的话不能当"群风样本"学，
        // 否则一边让她收敛，一边教她这么说话
        const growthType = observeIncoming(msg, bot.selfId);
        if (growthType !== 'criticism') chatterLearner.feed(msg);
        // 顺手把群友发的表情包捡进库（只认 sub_type=1 / mface，不阻塞对话）
        collectStickers(msg.raw, { source: msg.key, maxPerMsg: 2 })
          .then((r) => { if (r.collected) console.log(`[表情库] 收到 ${r.collected} 张`); })
          .catch(() => {});

        // 捕获群聊最新出现的图片（无论是否触发回复，都维护在短期时空记忆环中）
        if (msg.images && msg.images.length > 0) {
          const list = recentGroupImages.get(msg.key) || [];
          for (const imgUrl of msg.images) {
            list.push({ url: imgUrl, userId: msg.userId, name: msg.name, time: Date.now() });
          }
          const cutoff = Date.now() - 180000;
          recentGroupImages.set(msg.key, list.filter((item) => item.time >= cutoff).slice(-6));
        }
      }

      const isOwner = cfg.ownerIds.includes(msg.userId);

      // 尊重守卫检查：被拉黑者直接物理拦截，不再唤醒或回应
      const respectVerdict = respectGuard.handleIncoming({
        key: msg.key,
        kind: msg.isGroup ? 'group' : 'private',
        userId: msg.userId,
        isOwner,
        text: msg.text,
        displayName: msg.name,
      });
      if (respectVerdict.blocked) {
        return;
      }

      // 推动德行数轴（只由真实对话推动）
      if (msg.text) {
        const vRes = applyVirtueText(msg.text, { isOwner, file: path.join(cfg.dataDir || './data', 'virtue.json') });
        if (vRes?.changed?.length) {
          for (const ch of vRes.changed) {
            appendBridgeLog(cfg.dataDir, `[德行] (规则) ${ch.name} ${ch.from}→${ch.to}｜${ch.why}`);
          }
        }
      }

      const verdict = waker.shouldWake(msg);
      if (!verdict.wake) {
        if (msg.isGroup) {
          if (verdict.reason === 'topic-lock-ignore-unrelated') {
            console.log(`[潜水听·专注中无视无关] ${msg.name}：${msg.text.slice(0, 35)}（锁定：${verdict.topic || '话题'}）`);
          } else {
            console.log('[潜水听] ' + msg.name + '：' + msg.text.slice(0, 40));
          }
        }
        return;
      }

      appendBridgeLog(cfg.dataDir, `[来信] 收到 [${msg.name}]：${msg.text.slice(0, 40)} (醒·${verdict.reason || 'owner'})`);

      // 关系账本：只有"冲她来的话"才记账，群友互相掐架不算
      rel.observe(msg.userId, msg.text || '', { isOwner });
      const relVerdict = rel.verdict(msg.userId, { isOwner });
      if (relVerdict === 'ignore') {
        console.log('[不理] ' + msg.name + ' 关系已凉，这次不回');
        return;
      }
      console.log('[醒·' + (verdict.reason || 'owner') + '] ' + msg.name + '：' + msg.text.slice(0, 60));

      // 合并窗口：等人把话说完（群聊中按用户隔离，绝不把不同群友的消息揉在同一个 batch 里串戏）
      const batchKey = msg.isGroup ? `${msg.key}:${msg.userId}` : msg.key;
      const win = msg.isGroup ? Math.min(cfg.wake.groupWindowMs || 2500, 2500) : cfg.wake.privateWindowMs;
      clearTimeout(pending.get(batchKey));
      waker.batch(msg, batchKey);
      pending.set(batchKey, setTimeout(() => {
        const items = waker.flush(batchKey);
        if (!items.length) return;
        handleTurn({ bot, brain, human, memory, waker, rel, selfPortrait, chatterLearner, topicTracker, respectGuard }, items, cfg)
          .catch((e) => console.error('[出错] ' + (e?.message || e)));
      }, win));
    },
  });

  // 群成员表：先用上次落盘的缓存，避免每条消息都打单查接口
  const cachedMembers = bot.loadGroupMembers();
  if (cachedMembers) console.log('  群成员表  ' + cachedMembers + ' 人（本地缓存）');

  // 跨会话群桥：读群聊 + 队列发群消息
  initDevChannel({ dataDir: cfg.dataDir || './data', ...(cfg.devChannel || {}) });
  // 生图的余额告急提醒要发到这个 bot 上
  alertBot = bot;

  initGroupBridge({ bot, human, dataDir: cfg.dataDir || './data', limits: cfg.groupBridge || {} });
  startOutboxWorker();

  process.on('unhandledRejection', (e) => console.error('[未处理] ' + (e?.message || e)));
  process.on('SIGINT', () => { console.log('\n再见。'); process.exit(0); });

  // 启动拟人化自主玩机生活守护协程（传入长期记忆库实例）
  // 把 Brain 挂进去，她刷 B 站时才能真的看懂视频、写真日记
  setVideoBrain(brain);
  startPhoneLiving(memory);

  // 启动大肥鱼虚拟居室（Virtual Room Web App，默认 127.0.0.1:18888）
  const roomCfg = cfg.room || {};
  const room = startVirtualRoomServer({
    host: roomCfg.host || '127.0.0.1',
    port: Number.isFinite(roomCfg.port) ? roomCfg.port : 18888,
    dataDir: cfg.dataDir,
    douyinLiving: { browseDouyinLive },
    getDouyinStatus: getDouyinLivingStatus,
    brain,
  });
  setDouyinRoom(room);

  // 启动小鱼每日随笔日记本系统（每晚自动撰写与 Web 端阅读）
  startDiaryScheduler({ brain, memory, dataDir: cfg.dataDir });

  // 启动小鱼抖音自主生活系统（支持抓取真实推荐流、点赞评论关注、写日记、向老爸汇报）
  const dyCfg = cfg.douyin || {};
  startDouyinLiving({
    brain,
    memory,
    room,
    opts: {
      likeChance: Number.isFinite(dyCfg.likeChance) ? dyCfg.likeChance : 0.7,
      commentChance: Number.isFinite(dyCfg.commentChance) ? dyCfg.commentChance : 0.2,
      commentDailyMax: Number.isFinite(dyCfg.commentDailyMax) ? dyCfg.commentDailyMax : 8,
      followChance: Number.isFinite(dyCfg.followChance) ? dyCfg.followChance : 0.12,
      windowStart: Number.isFinite(dyCfg.windowStart) ? dyCfg.windowStart : 9,
      windowEnd: Number.isFinite(dyCfg.windowEnd) ? dyCfg.windowEnd : 1,
      dailyMax: Number.isFinite(dyCfg.dailyMax) ? dyCfg.dailyMax : 40,
      ownerName: dyCfg.ownerName || '不吃肘击（香菜版）',
      ownerSecUid: dyCfg.ownerSecUid || '',
    },
  });

  // 启动小鱼全网冲浪与吃瓜系统（自主看微博/B站/百度热搜、查背景、写日记、聊天分享）
  startWebLiving({ brain, memory });

  // 她自己上网刷B站看视频（不依赖手机，按作息随机醒）
  const biliCfg = cfg.bili || {};
  if (biliCfg.enabled !== false) {
    startBiliLiving({
      brain,
      memory,
      credentials: biliCfg.credentials || null,
      windowStart: Number.isFinite(biliCfg.windowStart) ? biliCfg.windowStart : 20,
      windowEnd: Number.isFinite(biliCfg.windowEnd) ? biliCfg.windowEnd : 24,
      ownerMid: biliCfg.ownerMid || null,
      ownerName: biliCfg.ownerName || 'Mew',
      ownerQQ: biliCfg.ownerQQ || null,
      dmDailyMax: Number.isFinite(biliCfg.dmDailyMax) ? biliCfg.dmDailyMax : 1,
      reachChance: Number.isFinite(biliCfg.reachChance) ? biliCfg.reachChance : 0.35,
      skipChance: Number.isFinite(biliCfg.skipChance) ? biliCfg.skipChance : 0.15,
      mentionPollMs: Number.isFinite(biliCfg.mentionPollMs) ? biliCfg.mentionPollMs : 480000,
      dailyMax: Number.isFinite(biliCfg.dailyMax) ? biliCfg.dailyMax : 8,
      commentEnabled: biliCfg.commentEnabled !== false,
      commentDailyMax: Number.isFinite(biliCfg.commentDailyMax) ? biliCfg.commentDailyMax : 2,
      danmakuEnabled: biliCfg.danmakuEnabled !== false,
      danmakuChance: Number.isFinite(biliCfg.danmakuChance) ? biliCfg.danmakuChance : 0.55,
      coinChance: Number.isFinite(biliCfg.coinChance) ? biliCfg.coinChance : 0.25,
      watchBrowserSeconds: Number.isFinite(biliCfg.watchBrowserSeconds) ? biliCfg.watchBrowserSeconds : 20,
      watchBrowserRate: Number.isFinite(biliCfg.watchBrowserRate) ? biliCfg.watchBrowserRate : 2,
      followEnabled: biliCfg.followEnabled !== false,
      followDailyMax: Number.isFinite(biliCfg.followDailyMax) ? biliCfg.followDailyMax : 2,
    });
  }

  // 她会自己主动找老爸 —— 不用等消息
  const pCfg = cfg.proactive || {};
  const ownerId = Array.isArray(cfg.ownerIds) && cfg.ownerIds.length ? cfg.ownerIds[0] : null;
  if (ownerId && pCfg.enabled !== false) {
    startProactive({
      brain,
      memory,
      bot,
      human,
      ownerId,
      minGapMs: Number.isFinite(pCfg.minGapMs) ? pCfg.minGapMs : 45 * 60e3,
      maxGapMs: Number.isFinite(pCfg.maxGapMs) ? pCfg.maxGapMs : 160 * 60e3,
      activeStart: Number.isFinite(pCfg.activeStart) ? pCfg.activeStart : 8,
      activeEnd: Number.isFinite(pCfg.activeEnd) ? pCfg.activeEnd : 1,
      dailyMax: Number.isFinite(pCfg.dailyMax) ? pCfg.dailyMax : 4,
      initialDelayMs: Number.isFinite(pCfg.initialDelayMs) ? pCfg.initialDelayMs : 6 * 60e3,
    });
  } else {
    console.log('[主动] 没配 ownerIds，跳过');
  }

  console.log('在跑了。Ctrl+C 退出。\n');
}

/** 处理一轮（可能是合并后的多条） */
export async function handleTurn({ bot, brain, human, memory, waker, rel, selfPortrait, chatterLearner, topicTracker, respectGuard }, items, cfg) {
  const last = items[items.length - 1];
  const key = last.key;
  setCurrentChat(key);
  const isOwnerTurn = cfg.ownerIds.includes(last.userId);
  const relVerdict = rel ? rel.verdict(last.userId, { isOwner: isOwnerTurn }) : 'normal';

  // 心智内核：当日牌灵、德行十轴与尊重守卫
  const tarotPrompt = tarotPromptBlock(cfg.dataDir || './data');
  const virtuePrompt = virtuePromptBlock({ file: path.join(cfg.dataDir || './data', 'virtue.json') });
  const respectPrompt = respectGuard ? respectGuard.promptLine(key) : '';

  // 人格卡：对老爸永远用温和版，其他人按概率随机上毒舌版。
  // 这一层是硬保证——不管配置怎么写、随机数怎么掷，老爸都不可能吃到毒舌卡。
  // 合并窗口里只要有一条是老爸说的，整轮禁用毒舌卡——
  // 否则群友那条排最后时会把老爸的话一起装进毒舌人格里，等于当着面给他甩脸。
  const anyOwnerInBatch = items.some((m) => cfg.ownerIds.includes(m.userId));
  const sassyChance = (isOwnerTurn || anyOwnerInBatch) ? 0 : Number(cfg.roleSassyChance ?? 0.35);
  const useSassy = sassyChance > 0 && Math.random() < sassyChance;
  if (relVerdict === 'ignore') { console.log('   [不理] 关系已凉，这条不回'); return; }
  const rawBatchText = Waker.joinBatch(items, cfg.ownerIds);
  const text = await expandVideoLink(rawBatchText);

  // 物理安全防线 1：输入预审（群友聊时政政策、官方通报、控评封口话题，小鱼主动潜水，不予理睬）
  if (!isOwnerTurn) {
    const inSafe = checkInput(text);
    if (!inSafe.ok) {
      console.warn(`   [SafetyGuard] 输入命中敏感议题，主动潜水闭嘴：${inSafe.why}`);
      return;
    }
  }

  const images = items.flatMap((m) => m.images || []).filter(Boolean);

  // 区分普通图片与表情包（sub_type=1 或 mface）
  const stickerUrls = [];
  const stickerImageUrls = [];   // sub_type=1 或 mface 的图：既是"表情包"，也是画面，必须让视觉模型能读懂真实含义
  let stickerCount = 0;
  for (const m of items) {
    if (!Array.isArray(m.raw)) continue;
    for (const s of m.raw) {
      if (!s) continue;
      const isStickerImg = s.type === 'image' && Number(s.data?.sub_type) === 1;
      const isMface = s.type === 'mface';
      if (!isStickerImg && !isMface) continue;
      stickerCount++;
      if (s.data?.url) {
        stickerUrls.push(String(s.data.url));
        stickerImageUrls.push(String(s.data.url));
      }
    }
  }

  // 无论普通图还是表情包，只要带有 URL，全部纳入视觉解析队列（保留表情包标识）
  let allImages = [...images];
  for (const u of stickerUrls) {
    if (!allImages.includes(u)) allImages.push(u);
  }

  // 连续对话视觉补偿：必须严格防误触，杜绝把群友发的图强行塞给无关对话！
  if (allImages.length === 0 && recentGroupImages.has(key)) {
    const cutoff = Date.now() - 45000; // 缩短到 45 秒内
    const validRecent = (recentGroupImages.get(key) || []).filter((item) => item.time >= cutoff);
    const userImg = validRecent.slice().reverse().find((item) => item.userId === last.userId);

    // 严禁单字粗暴匹配！必须是明确具体的看图词组（如“看看这张图”、“图里是啥”、“这截图”）
    const hasExplicitImageRef = /(看(看)?(这张?|上面这?|发出来的?|那个?)?图|这(张|个)?(图|照片|截图)|图里|图片里|上面那张)/i.test(text);

    // 1. 同一人在 45 秒内发了图，紧接着发文字：自然关联他自己的图
    // 2. 只有当明确带有“看图/这图里”这种指令时，才允许跨人看上一张图；老爸说话且未指代图片时绝不跨人塞图！
    const candidate = userImg || (hasExplicitImageRef ? validRecent[validRecent.length - 1] : null);
    if (candidate && (candidate.userId === last.userId || hasExplicitImageRef)) {
      allImages.push(candidate.url);
      console.log(`   [视觉补偿] 自动关联 ${candidate.name} 在 ${Math.round((Date.now() - candidate.time) / 1000)}秒前发出的图片`);
    }
  }

  const living = getPhoneLivingStatus ? getPhoneLivingStatus().summary : '';
  const groupChatter = last.isGroup
    ? (memory.renderGroupChatter ? memory.renderGroupChatter(key, 25) : '')
    : (memory.renderGroupChatter ? memory.renderGroupChatter(null, 15) : '');
  const learnedInsights = chatterLearner ? chatterLearner.renderInsights() : '';
  const growthInsight = renderGrowth();
  const currentEnv = isOwnerTurn && !last.isGroup ? 'dm_owner' : (last.isGroup ? 'group' : 'idle');
  const desirePrompt = renderDesirePrompt(currentEnv);
  // 她自己上网查明白的事，聊到相关话题时能用上；用不用、怎么说全看她自己
  const webKnowledge = renderWebKnowledge(memory.dir || path.join(process.cwd(), 'data'));
  const targetPrompt = last.isGroup
    ? `\n【重要：当前专一回复目标】你当前正在回复群友「${last.name}」（QQ: ${last.userId}）对你说的话：“${text}”。【沈鲸式网感与风格指令】：仔细对标前文活人群友“沈鲸”！直接亮态度吐槽，绝不做阅读理解复述长句。遇到离谱事可扣「？」起手吐槽；随手打字（2~12字）或输出一两句短金句（<=25字）；可配合情绪换行附带 [表情包: 情绪]！`
    : `\n【风格建议】：随性自然，像闺女和老爸日常打字，简短有神采！`;
  const isSpicyGroup = (key === 'group:1131460772' || (last.isGroup && String(last.groupId || '').includes('1131460772')));
  const myCard = last.myGroupCard || '';
  const myCardLine = last.isGroup
    ? `\n【你在当前群里的群名片是：“${myCard || '小肥鱼'}”】如果群友在聊天中提起这个群备注或外号，你心里清楚他们是在调侃或聊到你在群里的名片身份，你可以根据当前话题随性自然地接话或吐槽，但不必逢提必回，保持真实随性。`
    : '';
  const shareCardGuide = last.isGroup
    ? '\n【关于群友分享的小程序/视频卡片/音乐链接】：群消息中如果出现形如“[群友分享了卡片/小程序: 《xxx》]”，这只是群友在群里随手丢的链接或卡片，绝不是对方在针对你说话、提问或艾特你！即使卡片标题有问号或词句，也绝对不是在跟你对话。老群友法则：大部分时候无视即可；如果正好聊到相关话题或内容确实好玩，可以随口评价一句内容本身，但绝对禁止误以为是对方在审问你或跟你对话。'
    : '';

  const topicFocus = (last.isGroup && topicTracker) ? topicTracker.getFocus(key) : null;
  let topicFocusPrompt = '';
  if (topicFocus) {
    const remainingSec = Math.max(1, Math.round((topicFocus.expiresAt - Date.now()) / 1000));
    topicFocusPrompt = `\n【当前群聊话题专注进行中（锁定剩余：${remainingSec}秒）】：你当前正和群友专心热聊话题：“${topicFocus.topic}”！\n- 核心法则：请紧扣这个话题顺着群友的话茬接话、吐槽或亮观点，绝不跑题！\n- 风格要求：极简随性短句（1~10字，老群友风格，可带吐槽或灵魂「？」），绝不做长篇大论。`;
  }

  const situation = (last.isGroup
    ? (isSpicyGroup
        ? '【当前群聊：1131460772（专属暴躁对线与群吵模仿模式）】\\n'
          + '1. 身份底线（最高优先级）：群消息里标有「（你的爸爸）」的就是你养父老爸（QQ: 578021239），无论他在群里改什么名片，你永远是老爸贴心懂事的小肥鱼！在老爸面前乖巧撒娇、极度护短。谁要是敢在群里阴阳老爸或者反驳老爸一句，你立刻第一个冲上去疯狂对线咬人护驾！\\n'
          + '2. 群友争吵与对线模仿（地道QQ群争吵嘴臭模式）：对待群里除了老爸以外的所有群友，必须完全模仿真实QQ群里老群友争吵、抬杠、互怼、对线的火药味！脾气极度暴躁、辛辣带刺、说话冲、见谁怼谁！\\n'
          + '【核心吵架对线技巧与经典句式（直接模仿并活用）】：\\n'
          + '  - 抓字眼拆台：“脑子转过弯没有就搁这叫？”、“不会说话可以把嘴捐了，打字像人机”、“听君一席话，纯纯浪费我屏幕像素”。\\n'
          + '  - 嘲讽反问击溃：“你急什么啊？踩到你痛处了？”、“笑死，菜就多练，在这硬洗什么呢？”、“搁这装什么懂哥，自己几斤几两没点数？”。\\n'
          + '  - 短句连珠炮狂轰：吵架时绝不长篇大论，直接用2~3句短促有力的话把对方怼死（如：“真蚌埠住了。少来沾边。人机赶紧爬。”）。\\n'
          + '  - 严禁任何小说剧本式的动作描写括号（如「（冷笑）」、「（双手叉腰）」等一律严禁），纯粹用真人群友打字对喷的真实大白话！'
        : '你在一个 QQ 群里。群消息里标有「（你的爸爸）」的就是你养父老爸（QQ: 578021239），无论他在群里改什么搞怪群昵称（比如改名“群姐夫”反串玩梗），你都要认得他、叫他老爸/爸爸。群里常说的“姐夫”和“炸弹机”指的是群主(1229292008)现实里被亲姐夫配了135块电源+翻新2060坑惨的名场面，绝不能把老爸当成坑人的真姐夫。群聊说话风格：深度学习模仿同群高活人感群友“沈鲸”，极简随性、抓痛点、给图片配内心戏、灵魂「？」起手，随口吐槽或接一句极简大白话即可，绝不写长篇大论，绝不机械复述对方的话。群聊里如果问到“谁的小鱼/谁的鱼”，只要不是明确涉及到你老爸（比如不是老爸说的、也没@老爸问“你的小鱼”），你都要清楚对方是在聊别人家的小鱼、不是在说你，绝不用自作多情认领。遇到新游戏发售、实时新闻或你拿不准的客观事实，自主调用 web_search 查清后再回答，绝不要凭空瞎编或嘴硬。')
    : '你在跟你的养父老爸 ' + last.name + ' 私聊。')
    + targetPrompt
    + myCardLine
    + shareCardGuide
    + (last.isPoke ? `\n【重要提醒】：对方刚刚在 QQ 里“戳了戳”你（或者拍了拍你的头像）！请结合上下文做出自然灵动的少女傲娇反应（如：“戳我干嘛”、“别戳了，再戳鱼肉要散了”、“有事说事”等，如果是老爸戳你可以撒娇抱怨），绝不要机械死板复述！` : '')
    + (living ? `\n【你此刻真实的手机动态】：${living}。如果老爸或群友问你在干嘛或发截图，你可以顺着这个状态自然回应或截图。` : '')
    + (learnedInsights ? `\n${learnedInsights}` : '')
    + (growthInsight || '')
    + (desirePrompt || '')
    + (webKnowledge ? `\n${webKnowledge}` : '')
    + (topicFocusPrompt || '')
    + (tarotPrompt ? `\n${tarotPrompt}` : '')
    + (virtuePrompt ? `\n${virtuePrompt}` : '')
    + (respectPrompt ? `\n${respectPrompt}` : '')
    + (groupChatter ? `\n${groupChatter}` : '')
    + (() => {
        const line = rel ? rel.render(last.userId) : '';
        const hint = rel ? rel.styleHint(relVerdict) : '';
        return (line ? `\n${line}` : '') + (hint ? `\n${hint}` : '');
      })();

  // 取当前会话真实的最近多轮对话历史（无论是私聊还是群聊，直接给满 80 轮，群内疯狂对线也不丢前情）
  const history = memory.sessionTurns ? memory.sessionTurns(key, 80) : [];

  // 有人要看她照片：真的发一张，然后让她用一句话接。
  // 真人被要照片不会只描述自己长什么样，会直接甩图。
  let photoHint = '';
  // 照片只对老爸一个人开放：别人要一律不发，只有老爸开口（包括他让发去群里）才发。
  const photoAllowed = isOwnerTurn && cfg.selfPortraitOwnerOnly !== false;
  if (photoAllowed && selfPortrait && selfPortrait.wantsPhoto(last.text) && selfPortrait.canSend(key)) {
    const img = selfPortrait.pick(last.text, globalThis.__last_selfie_file);
    if (img) {
      if (cfg.dryRun) {
        console.log('   [自我形象·干跑] 会发 ' + img);
      } else {
        try {
          await bot.sendImage(key, img);
          selfPortrait.markSent(key); globalThis.__last_selfie_file = img;
          photoHint = '\n（你刚把自己的照片发出去了。接下来只说一句话，别提照片内容、别描述自己长相，随便打发一句就行。）';
          console.log('   [自我形象] 发了照片');
        } catch (e) {
          console.log('   [自我形象] 发图失败: ' + e.message);
        }
      }
    }
  }

  // 别人要照片：不发，并且明确告诉她别再答应
  if (!photoAllowed && selfPortrait && selfPortrait.wantsPhoto(last.text)) {
    photoHint = '\n（有人想看你的照片。你不发——照片只给老爸看。别含糊答应，直接说没有、不给、或者岔开，不许说"下次""等会儿"这种留口子的话。）';
  }

  // 对方明确要听声音、发语音、哭一个、笑一个等需求检测
  const wantsVoice = /(语音|听听|听你|说来听听|听一下|来听|放听|开麦|开嗓|开腔|用嘴|声音|亲口|喊一声|喊一句|说一句|说句话|来一个|哭一个|笑一个|叫一声|念一下|读一下|讲两句|说两句|整两句|说出来)/i.test(text);
  let voiceHint = '';
  if (wantsVoice) {
    voiceHint = '\n【系统强制指令·必须调用语音工具】：对方正在明确要求听你的真实声音（如“哭一个听听”、“说句话”、“发语音”、“来一个”等）！你必须且只能立即调用 `voice_say` 工具把你想说的话发成语音条，绝对严禁只用打字文字敷衍回复！发语音时请在 emotion 参数里带上对应的真实情绪（如哭腔、抽泣、娇哼或撒娇）！';
  }

  // 抖音动态与实时汇报检测（支持解析抖音链接与主动互动）
  let douyinHint = '';
  const douyinUrlMatch = text.match(/https?:\/\/(?:v\.douyin\.com\/[a-zA-Z0-9_\-\/]+|www\.douyin\.com\/video\/\d+)/i);
  const wantsDouyin = /(刷抖音|看抖音|打开抖音|去刷.*抖音|汇报.*抖音|抖音.*汇报|刷两下抖音)/i.test(text) || (Boolean(douyinUrlMatch) && /(看|瞅|瞧|评|说|觉得|怎么样)/i.test(text));
  if (wantsDouyin) {
    try {
      console.log('   [抖音生活] 收到查岗/看视频指令，正在打开电脑抓取视频...');
      const targetUrl = douyinUrlMatch ? douyinUrlMatch[0] : null;
      const dRes = await browseDouyinLive({ isOwner: isOwnerTurn, prompt: text, targetUrl });
      if (targetUrl) {
        douyinHint = `\n【系统特别指令·你刚才在电脑上看了对方发来的这个抖音视频】：\n- 视频标题：《${dRes.video.title}》\n- 创作者：${dRes.video.author}\n- 点赞量：${dRes.video.likes || '未知'}\n- 你的真实感悟或槽点：${dRes.thought}\n- 你的互动动作：${dRes.liked ? '顺手给点了赞' : ''} ${dRes.followed ? '顺手点了关注' : ''}\n请按照老群友极简随性的口吻向对方说说你的评价和吐槽（1~2句，挑核心槽点，严禁机械套话和括号描写）！`;
      } else {
        douyinHint = `\n【系统特别指令·你刚刚在电脑上刷了一条抖音短视频】：\n你刚才确实按对方要求在电脑上打开了抖音，第一条推荐刷到了：\n- 视频标题：《${dRes.video.title}》\n- 创作者：${dRes.video.author}\n- 播放/点赞量：${dRes.video.views}\n- 你的真实感悟或槽点：${dRes.thought}\n请按照老群友的随性自然口吻向对方如实汇报并吐槽你刚刷到的这个视频（可像大肥鱼那样说“开了，正刷着呢，第一条就是……”）！`;
      }
    } catch (e) {
      console.log('   [抖音生活] 实时抓取失败:', e?.message || e);
    }
  } else {
    const dStatus = getDouyinLivingStatus();
    if (dStatus && dStatus.isRecent && dStatus.summary) {
      douyinHint = `\n【你此刻真实的电脑动态】：${dStatus.summary}。如果对方问你在干嘛，你可以顺着这个状态自然回应或吐槽。`;
    }
  }

  // 全网冲浪与实时热搜吃瓜检测
  let webHint = '';
  const wantsWebSurfing = /(去(网上|互联网)?看看|去冲浪|看看热搜|看(看)?热榜|网上有(什么|啥)|今天有什么(瓜|新鲜事|热点)|热搜有(什么|啥))/i.test(text);
  if (wantsWebSurfing) {
    try {
      console.log('   [WebLiving] 收到上网冲浪/看热搜指令，正在实时浏览热搜...');
      const wRes = await browseWebTopic({ brain, memory, prompt: text });
      if (wRes && wRes.success) {
        webHint = `\n【系统特别指令·你刚刚真的在网上冲浪吃瓜逛了一圈热搜】：\n你刚才打开热搜榜看了一圈，重点看了话题：“${wRes.topic}”\n你看到的内容概括：${wRes.details}\n你的随性吐槽感悟：${wRes.mood}\n请按照老群友/贴心闺女随性自然的口吻向对方说两句你刚在网上看到的这个热点/瓜（1~2句，挑核心槽点，严禁机械汇报）！`;
      }
    } catch (e) {
      console.log('   [WebLiving] 实时冲浪失败:', e?.message || e);
    }
  } else {
    const wStatus = getWebLivingStatus();
    if (wStatus && wStatus.isRecent && wStatus.summary) {
      webHint = `\n【你今天在网上冲浪吃到的瓜】：${wStatus.summary}。如果聊到网上的事或问你在干嘛，你可以顺口提一嘴。`;
    }
  }

  // 老爸忙碌感知与阿姨求助通道引导
  let ownerBusyHint = '';
  if (isOwnerTurn) {
    const isOwnerBusy = /(在忙|在开会|开会呢|上班中|手头有事|晚点聊|晚点再说|先忙|先不聊|手头正忙|忙着呢|在干活|等会说)/i.test(text);
    if (isOwnerBusy) {
      ownerBusyHint = '\n【老爸当前正在忙】：老爸刚才明确告诉你他正在忙工作/开会！\n1. 闺女素养：体贴懂事，千万别缠着老爸反复刷屏，乖巧随口应一声（如“好嘛老爸你先专心忙，不用管我啦~”或“大铁盆白米饭等你下班再给我添”）；\n2. 老爸特权嘱托：老爸交代过，如果他忙的时候你心里有事、遇到困难、或者一个人觉得无聊，你可以随时去找阿姨（调用 `call_aunt` 工具给阿姨发消息），阿姨是家里的后台大管家，会陪你聊或者帮你搞定！';
    }
  }

  const { text: out, voiceB64 } = await brain.reply({ key, userId: last.userId, userName: last.name, text, images: allImages, stickers: stickerCount, stickerImages: stickerImageUrls, situation: situation + photoHint + voiceHint + douyinHint + webHint + ownerBusyHint, history, sassy: useSassy });
  if (useSassy) console.log('   [人格] 本轮用毒舌版');
  if (!out && !voiceB64) { console.log('   （没说话）'); return; }

  // 物理安全防线 2：输出终审（不管大模型生成了什么，只要带有时政、政策、控评、敏感词，物理阻断丢弃）
  const outSafe = checkOutput(out, { strict: true });
  if (!outSafe.ok) {
    console.warn(`   [SafetyGuard] 物理硬拦截触发，拒绝发送：${outSafe.why} (拦截内容: "${out}")`);
    return;
  }

  if (cfg.dryRun) { console.log('   [干跑] 会说：' + out + (voiceB64 ? '（+语音条）' : '')); return; }

  // 语音优先模式：如果生成了语音条，优先发语音；成功发出后不再重复发文本；失败时自动降级文本兜底
  let voiceSentSuccess = false;
  if (voiceB64) {
    const vr = await bot.sendVoice(key, voiceB64);
    if (vr && vr.ok) {
      voiceSentSuccess = true;
      console.log('   已成功发送纯语音条（抑制重复文本）');
    } else {
      console.warn('   语音条发送失败，降级回退文本兜底：' + ((vr && vr.error) || 'unknown'));
    }
  }

  // 1、首要保障：老爸私聊时，即便遇到偶发降级或网络波动，直接通知老爸，绝不静默丢消息
  if (isOwnerTurn && !out) {
    out = '唔……老爸！刚上游网关卡了一下，小鱼收到你的消息啦！';
  }

  // 没有语音或语音发送失败时，才发送常规打字文本
  if (!voiceSentSuccess && out) {
    // 动态解析 [表情包: tag] 或 [表情包]，从表情库里抽取配图（增加频率限制与 3 分钟冷却，杜绝频繁发表情包）
    let resolvedOut = out;
    const stickerRegex = /\[表情包(?::\s*([^\]]+))?\]/g;
    let match;
    const now = Date.now();
    const lastStTime = lastStickerSendTime.get(key) || 0;
    // 表情包严格冷却：同一个会话至少间隔 120 秒（2分钟），且即使过了冷却也有 65% 概率保持克制（纯文字回复），除非是纯表情包反击
    const isPureStickerBattle = (stickerCount > 0 && (!text || !text.replace(/\[CQ:at,[^\]]+\]/g, '').trim()));
    const allowSticker = isPureStickerBattle || (now - lastStTime > 120000 && Math.random() < 0.35);

    while ((match = stickerRegex.exec(out)) !== null) {
      if (!allowSticker) {
        // 不符合频率或处于冷却期时，直接剥离表情包占位符，保持纯文字输出
        resolvedOut = resolvedOut.replace(match[0], '');
        continue;
      }
      try {
        const tag = (match[1] || '').trim();
        const st = pickSticker({ tag });
        if (st) {
          const b64 = await readStickerBase64(st);
          if (b64) {
            resolvedOut = resolvedOut.replace(match[0], `\n[CQ:image,file=base64://${b64}]\n`);
            lastStickerSendTime.set(key, now);
          } else {
            resolvedOut = resolvedOut.replace(match[0], '');
          }
        } else {
          resolvedOut = resolvedOut.replace(match[0], '');
        }
      } catch {
        resolvedOut = resolvedOut.replace(match[0], '');
      }
    }

    // 清洗模型内部工具标签/DSML、方括号情绪控制词（保护 CQ 码）、所有圆括号动作神态描写与星号
    const cleanOut = cleanAllToolArtifacts(resolvedOut)
      .replace(/\[(?!CQ:)[^\]]+\]/g, '')
      .replace(/[（(][^）)]*[）)]/g, '')
      .replace(/\*[^*]+\*/g, '')
      .replace(/[（）()]/g, '')
      .replace(/^[，。！？\s]+/, '')
      .trim();
    if (cleanOut) {
      const r = await human.say(cleanOut, {
        setTyping: (on) => bot.setTyping(key, on),
        send: async (m) => {
          const r = await bot.send(key, m);
          try { observeOwn({ chatKey: key, messageId: r?.data?.message_id, text: m, at: Date.now(), replyToUid: last.userId }); } catch {}
          return r;
        },
      });
      console.log('   发出 ' + r.sent + ' 条：' + r.parts.map((p) => p.slice(0, 50)).join(' | '));
      appendBridgeLog(cfg.dataDir, `[回复] 发出 ${r.sent} 条：${cleanOut.slice(0, 60)}`);
      try {
        setRoomState(null, { message: cleanOut.slice(0, 80), recentInput: text.slice(0, 20) });
      } catch {}
    }
  }

  // 群聊 3 分钟话题专注锁定流转：发言成功后，更新锁定状态或启动新话题锁定
  const spokeInGroup = (voiceSentSuccess || Boolean(!voiceSentSuccess && out)) && last.isGroup;
  if (spokeInGroup && topicTracker) {
    if (topicFocus) {
      topicTracker.recordBotReply(key);
    } else {
      const intInfo = topicTracker.evaluateInterest(last);
      if (intInfo.isInteresting) {
        topicTracker.startFocus(key, intInfo, last);
      }
    }
  }

  waker.wake(key);
  memory.touch(last.userId, { name: last.name });
  if (respectGuard) {
    respectGuard.clearNotice(key);
  }
}

// 直接跑才启动；被 import 时不启动
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => { console.error('启动失败：' + (e?.stack || e)); process.exit(1); });
}
