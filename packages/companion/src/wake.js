/**
 * 唤醒判定 · 什么时候该说话，什么时候该安静
 * ─────────────────────────────────────────────────────────────
 * 一个不会看场合的机器人，比不会说话的更烦人。
 *
 * 这里把"要不要醒"拆成几个独立条件，任何一个命中就醒：
 *
 *   atMention    被 @ / 被引用
 *   nameMention  被叫到名字或昵称
 *   keywords     出现了约定好的关键词
 *   question     有人直接提问
 *   poke         被拍一拍
 *   speakerIds   指定的某几个人发言
 *   probability  普通消息按概率随机（让它偶尔插话，但别刷屏）
 *   anyMessage   任何消息都醒（"活跃模式"）
 *
 * 另外还有一个「无限期潜水」概念：醒过一次之后，接下来一段时间
 * 除非再次命中条件，否则都当没看见。这就是群聊里"潜水"的实现。
 */

import { classifyMessage } from './conversation-closure.js';

/** 中文里"在问问题"的粗略特征 */
const QUESTION_HINTS = /[?？]|怎么|为什么|为啥|如何|是不是|能不能|可不可以|有没有|谁|哪儿|哪里|何时|多少/;

export class Waker {
  /**
   * @param {object} opts
   * @param {string[]} [opts.names]        她的名字/昵称列表
   * @param {string[]} [opts.keywords]     关键词
   * @param {string[]} [opts.ownerIds]     主人（说话必醒）
   * @param {number}  [opts.probability]   普通消息随机唤醒概率
   * @param {number}  [opts.batchWindowMs] 多条消息合并窗口
   */
  constructor(opts = {}) {
    this.names = (opts.names || []).filter(Boolean);
    this.keywords = (opts.keywords || []).filter(Boolean);
    this.ownerIds = (opts.ownerIds || []).map(String);
    this.probability = opts.probability ?? 0.05;
    this.batchWindowMs = opts.batchWindowMs ?? 3000;
    /** @type {import('./topic-focus.js').TopicFocusTracker|null} */
    this.topicTracker = opts.topicTracker || null;
    /** @type {Map<string, object>} 每个会话的唤醒配置 */
    this.configs = new Map();
    /** @type {Map<string, object>} 待合并的消息缓冲 */
    this.buffers = new Map();
  }

  setTopicTracker(tracker) {
    this.topicTracker = tracker;
  }

  /** 给某个会话设置唤醒配置 */
  setConfig(key, cfg) {
    this.configs.set(key, {
      mode: 'diving',          // 'diving' 潜水 | 'active' 活跃
      infinite: true,          // 无限期，直到再次命中条件
      until: 0,                // 有限潜水时的截止时间
      atMention: true,
      nameMention: true,
      keywords: [],
      question: false,
      poke: true,
      speakerIds: [],
      probability: this.probability,
      anyMessage: false,
      cooldownMs: 90000,
      ownerMustCall: false,
      ...cfg,
    });
  }

  getConfig(key) {
    if (!this.configs.has(key)) this.setConfig(key, {});
    return this.configs.get(key);
  }

  /** 现在是不是在潜水（潜水中 = 不该主动说话） */
  isDiving(key) {
    const c = this.getConfig(key);
    if (c.mode === 'active') return false;
    if (c.infinite) return true;
    return Date.now() < c.until;
  }

  /** 把它从潜水里叫起来 */
  wake(key) {
    const c = this.getConfig(key);
    c.lastWakeAt = Date.now();
    c.wakeCount = (c.wakeCount || 0) + 1;
  }

  /** 让它继续潜水（可以指定潜多久） */
  dive(key, ms = 0) {
    const c = this.getConfig(key);
    c.infinite = !ms;
    c.until = ms ? Date.now() + ms : 0;
  }

  /**
   * 检查是否明确是在呼叫小鱼本尊：
   * 凡是问到“谁的小鱼/谁家的小鱼”，只要不是涉及到老爸（578021239 / 織梦行云），
   * 都说明是在说别人家的小鱼，不属于呼叫本尊。
   */
  findDirectNameCall(text, msg = {}) {
    if (!text || msg.isPureShareCard) return { hitName: null, cleaned: '' };
    let cleaned = String(text);
    const uid = String(msg.userId || '');
    const isOwner = this.ownerIds.includes(uid);
    const isAtOwner = Boolean(msg.isAtOwner);

    // 凡是提到“谁的小鱼/谁家的小鱼/谁的鱼”：
    cleaned = cleaned.replace(/(?:[^\s，。！？!?~]{1,6})?(?:的|家|家的)\s*(?:小鱼|小肥鱼|肥鱼|大肥鱼|鱼鱼|鱼妹|鱼)/g, (match) => {
      if (isOwner && /(?:我|咱|俺)/.test(match)) return match; // 老爸说“我的小鱼”
      if (/老爸|爸爸|織梦行云|织梦行云/.test(match)) return match;   // 别人说“老爸的小鱼”
      if (isAtOwner && /(?:你|您)/.test(match)) return match;    // 别人艾特老爸问“你的小鱼”
      return '__OTHER_FISH__';
    });

    const hitName = this.names.find((n) => n && cleaned.includes(n)) || null;
    return { hitName, cleaned };
  }

  /**
   * 判定一条消息要不要唤醒
   *
   * @param {object} msg
   * @param {string} msg.key          会话标识，如 'group:123' / 'private:456'
   * @param {string} msg.userId       发送者
   * @param {string} [msg.name]       发送者昵称
   * @param {string} msg.text         正文
   * @param {boolean} [msg.isAtMe]    是否 @ 了我
   * @param {boolean} [msg.isPoke]    是否拍一拍
   * @param {boolean} [msg.isQuoteMe] 是否引用了我
   * @returns {{wake:boolean, reason:string}}
   */
  shouldWake(msg) {
    const c = this.getConfig(msg.key);
    const text = String(msg.text || '');
    const uid = String(msg.userId || '');
    const isOwner = this.ownerIds.includes(uid);

    // 群聊中纯分享卡片/小程序（无额外手打文字）判定：
    // 除非明确被 @ 或引用回复，否则绝不当作对话，不触发问句、关键词、概率冒头或老爸闲聊搭腔
    if (msg.isGroup && msg.isPureShareCard && !msg.isAtMe && !msg.isQuoteMe) {
      return { wake: false, reason: 'group-pure-share-card' };
    }

    const { hitName: directlyCalledName, cleaned: cleanedText } = this.findDirectNameCall(text, msg);
    const directlyCalled = Boolean(msg.isAtMe || msg.isQuoteMe || msg.isPoke || directlyCalledName);

    // 0. 话题专注锁定检查 (Topic Focus Tracker):
    // 如果该群当前正处于 3 分钟话题专注锁定中：
    if (msg.isGroup && this.topicTracker) {
      const lockVerdict = this.topicTracker.checkMessage(msg, isOwner, directlyCalled);
      if (lockVerdict.inLock) {
        if (lockVerdict.wake) {
          return { wake: true, reason: lockVerdict.reason, topic: lockVerdict.topic };
        } else {
          return { wake: false, reason: lockVerdict.reason, topic: lockVerdict.topic };
        }
      }
    }

    // 1. 主人（老爸）说话判定：
    // 私聊中每条必醒；群聊中若开启了 ownerMustCall，没叫小鱼时当背景潜水；
    // 若未开启 ownerMustCall（如熟人小群），老爸说话时小鱼可主动搭腔，但在发言冷却期内且未被明确呼叫时保持礼貌倾听
    if (isOwner && c.mode !== 'active') {
      if (msg.isGroup) {
        if (c.ownerMustCall && !directlyCalled) {
          return { wake: false, reason: 'owner-chatting-with-group' };
        }
        if (!directlyCalled && c.cooldownMs > 0 && c.lastWakeAt && (Date.now() - c.lastWakeAt < c.cooldownMs)) {
          return { wake: false, reason: 'owner-cooldown' };
        }
      }
      return { wake: true, reason: 'owner' };
    }
    if (Array.isArray(c.speakerIds) && c.speakerIds.map(String).includes(uid)) {
      return { wake: true, reason: 'speaker' };
    }

    if (c.anyMessage) return { wake: true, reason: 'anyMessage' };
    if (c.mode === 'active') return { wake: true, reason: 'active' };

    // 2. 显式呼叫：被 @ / 被引用 / 被直接叫名字本尊 / 被拍一拍（最高优先级，在冷却期间也必定唤醒）
    if (c.atMention && (msg.isAtMe || msg.isQuoteMe)) return { wake: true, reason: 'atMention' };
    if (c.poke && msg.isPoke) return { wake: true, reason: 'poke' };
    if (c.nameMention && directlyCalledName) {
      return { wake: true, reason: 'name:' + directlyCalledName };
    }

    // 2.5 拟真对话收尾过滤：群聊中未被直接呼叫时，对方单纯附和（“嗯/好/666/收到”）或纯标点绝对不插话
    if (msg.isGroup && !directlyCalled) {
      const closureType = classifyMessage(text);
      if (closureType.kind === 'ack' || closureType.kind === 'silence') {
        return { wake: false, reason: 'conversation-closure-ack' };
      }
    }

    // 3. 关键词检查（使用清洗后的文本；潜水群聊不响应通用日常词，除非该群配置了专属 keywords）
    const kw = c.mode === 'diving' ? (c.keywords || []) : [...(c.keywords || []), ...this.keywords];
    if (kw.length) {
      const hit = kw.find((k) => k && cleanedText.includes(k));
      if (hit) return { wake: true, reason: 'keyword:' + hit };
    }

    // 4. 冷却检查：如果处于发言冷却期内（如 90 秒内），不再进行普通问句或随机概率冒头
    if (c.cooldownMs > 0 && c.lastWakeAt && (Date.now() - c.lastWakeAt < c.cooldownMs)) {
      return { wake: false, reason: 'cooldown' };
    }

    // 5. 问句触发（若开启）
    if (c.question && QUESTION_HINTS.test(text) && [...text].length >= 4) {
      return { wake: true, reason: 'question' };
    }

    // 6. 随缘低频冒头（受 probability / topicInterestProbability 与 cooldownMs 双重约束）
    const effectiveProb = Number(c.topicInterestProbability ?? c.probability);
    if (effectiveProb > 0 && Math.random() < effectiveProb) {
      if (this.topicTracker && msg.isGroup) {
        const intInfo = this.topicTracker.evaluateInterest(msg);
        if (intInfo.isInteresting) {
          return { wake: true, reason: 'topic-interest:' + intInfo.topic, topicInfo: intInfo };
        }
        // 如果是无聊的纯数字/打卡/单字无意义消息，随缘冒头也放弃，保持真实活人感
        return { wake: false, reason: 'uninteresting-skip' };
      }
      return { wake: true, reason: 'probability' };
    }

    return { wake: false, reason: '' };
  }

  /**
   * 把消息放进合并缓冲区
   *
   * @param {object} msg
   * @param {string} [customKey] 自定义缓冲键（如群聊按用户隔离）
   * @returns {{ready:boolean, batch:object[]}}
   */
  batch(msg, customKey = null) {
    const key = customKey || msg.key;
    let b = this.buffers.get(key);
    if (!b) { b = { items: [], timer: null }; this.buffers.set(key, b); }
    b.items.push(msg);
    if (b.items.length >= 6) return { ready: true, batch: this.#flush(key) };
    return { ready: false, batch: [] };
  }

  #flush(key) {
    const b = this.buffers.get(key);
    if (!b) return [];
    const items = b.items;
    b.items = [];
    return items;
  }

  /** 合并窗口到了，把攒的都取出来 */
  flush(key) { return this.#flush(key); }

  /** 把一批消息拼成一段给模型的输入（自动标注主人身份） */
  static joinBatch(items, ownerIds = []) {
    return items.map((m) => {
      const isOwner = Array.isArray(ownerIds) && ownerIds.map(String).includes(String(m.userId));
      const who = m.name || m.userId || '某人';
      const label = isOwner ? `${who}（你的爸爸）` : who;
      return label + '：' + String(m.text || '').trim();
    }).join('\n');
  }
}

export default Waker;
