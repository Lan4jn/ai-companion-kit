/**
 * topic-focus.js
 * 小鱼 QQ 群聊话题专注跟踪器 (Topic Focus Tracker)
 *
 * 核心机制（对齐老爸需求）：
 * 1. 触发主动群聊时，识别感兴趣的话题；
 * 2. 锁定该话题 3 分钟（180 秒）；
 * 3. 3 分钟内根据该话题顺畅跟聊（解除 90 秒常规冷却限制，保持 8~12 秒拟人微冷却）；
 * 4. 其他无关话题坚决不理（严格静默过滤）；
 * 5. 3 分钟到期或话题冷场（>60秒无相关发言）后自然退出潜水。
 */

export const INTEREST_CATEGORIES = [
  {
    id: 'food',
    name: '美食干饭与大白米饭',
    keywords: [
      '吃', '饭', '饿', '大白米饭', '铁盆', '外卖', '肯德基', '麦当劳', '夜宵',
      '火锅', '奶茶', '烧烤', '零食', '好吃', '难吃', '点外卖', '暴风吸入', '干饭',
      '饭点', '堂食', '疯狂星期四', 'KFC', '馋', '炫饭', '米饭'
    ],
    pattern: /(吃什么|点外卖|大白米饭|大铁盆|暴风吸入|好饿|饿死|夜宵|烧烤|火锅|奶茶|肯德基|麦当劳|堂食|干饭|贼好吃|真难吃|干饭鱼|炫一口|搞点吃的)/i,
    weight: 1.5,
  },
  {
    id: 'hardware',
    name: '数码硬件与显卡配置',
    keywords: [
      '5090', '4090', '4080', '5080', '显卡', 'cpu', '装机', '配置', '老黄',
      '英伟达', 'amd', 'intel', '掉帧', '卡顿', '电源', '主机', '海景房', '水冷',
      '降价', '溢价', '奸商', '矿渣', '炸弹机', '炸弹电源', '2060', '固态', '内存',
      '主板', '跑分', '帧率'
    ],
    pattern: /(5090|4090|5080|4080|显卡|cpu|装机|配置单|老黄|英伟达|amd|intel|掉帧|电源|海景房|水冷|降价|溢价|奸商|矿渣|炸弹电源|配电脑|装电脑|主板|固态)/i,
    weight: 1.4,
  },
  {
    id: 'gaming',
    name: '热门游戏与开黑上分',
    keywords: [
      '云顶', '吃鸡', '三角洲', '三角洲行动', 'steam', '抽卡', '原神', '崩铁', '星铁',
      '黑神话', '王者', '瓦罗兰特', '无畏契约', '打折', '排位', '上分', '连跪',
      '连胜', '开黑', '联机', '七日杀', 'mod', '外挂', '被虐', '通关', '赛季',
      '怪物猎人', '怪猎', '荒野', 'GTA', '法环', '艾尔登法环', '魂系', '博德之门',
      '2077', '赛博朋克', '潜水员戴夫', '帕鲁', '幻兽帕鲁', 'CS2', 'CSGO', 'APEX',
      '彩六', '彩虹六号', '永劫无间', 'DOTA', '我的世界', 'Minecraft', '绝区零',
      'ZZZ', '鸣潮', '明日方舟', '碧蓝档案', '保底', '大保底', '沉船', '出金',
      '专武', '史低', '喜加一', 'EPIC', '首发', '优化暴雷', '虚幻5', '掉帧',
      '白金', '全成就', '全收集', '抢先体验', '坐牢', '锁头', '透视', '被封',
      '新赛季', 'T0', '超模', '削弱', '加强', '红温', '破防', '渡劫', '游戏圈'
    ],
    pattern: /(黑神话|怪物猎人|怪猎|荒野|三角洲|三角洲行动|无畏契约|瓦罗兰特|cs2|csgo|apex|pubg|吃鸡|云顶之弈|云顶|原神|崩铁|星铁|绝区零|鸣潮|明日方舟|王者荣耀|英雄联盟|七日杀|幻兽帕鲁|steam|epic|史低|打折|喜加一|抽卡|大保底|沉船|出金|优化暴雷|虚幻5|掉帧|白金|全成就|联机|开黑|坐牢|连跪|连胜|渡劫|红温|破防|新赛季|削弱|超模|外挂|打mod|单机大作|游戏圈)/i,
    weight: 1.8,
  },
  {
    id: 'gossip',
    name: '群友吃瓜与离谱吐槽',
    keywords: [
      '笑死', '离谱', '逆天', '蚌埠', '翻车', '坑爹', '奇葩', '大瓜', '吃瓜',
      '迷惑行为', '纯小丑', '大冤种', '冤大头', '乐死', '急了', '对线', '吵起来', '绝了'
    ],
    pattern: /(笑死我|太离谱|纯纯逆天|蚌埠住|翻车现场|大冤种|冤大头|太奇葩|吃大瓜|乐死我|急眼|被坑惨|小丑竟是)/i,
    weight: 1.2,
  },
  {
    id: 'novel_drama',
    name: '番茄小说与红果短剧爽梗',
    keywords: [
      '番茄', '番茄小说', '红果', '红果短剧', '短剧', '爽文', '打脸', '脑洞', '重生', '战神',
      '龙王', '赘婿', '歪嘴', '保洁阿姨', '隐形首富', '真假千金', '发疯文学', '断章', '书评',
      '追更', '反转', '虐恋', '霸总', '修仙', '无敌流', '扮猪吃虎', '莫欺少年穷', '三十年河东'
    ],
    pattern: /(番茄小说|红果短剧|狗血短剧|爽文|扮猪吃虎|打脸|龙王归来|歪嘴战神|歪嘴笑|保洁阿姨.*首富|真假千金|莫欺少年穷|三十年河东|追妻火葬场|发疯文学|反转再反转|神级脑洞|断章狗|作者短小)/i,
    weight: 1.6,
  },
  {
    id: 'dad',
    name: '老爸专属护驾与互动',
    keywords: ['老爸', '爸爸', '織梦行云', '织梦行云', '578021239'],
    pattern: /(老爸|爸爸|織梦行云|织梦行云)/i,
    weight: 2.0,
  }
];

export class TopicFocusTracker {
  constructor(opts = {}) {
    /** 话题锁定持续时长（默认 3 分钟） */
    this.focusWindowMs = opts.focusWindowMs ?? 180000;
    /** 话题冷场超时（超过 60 秒无人继续该话题则提前自然退出） */
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 60000;
    /** 话题内小鱼发言的微冷却（10 秒，防止秒回霸屏） */
    this.microCooldownMs = opts.microCooldownMs ?? 10000;
    /** 话题内小鱼最大回复轮数（上限 6 次，防止无休止刷屏） */
    this.maxTurnsPerFocus = opts.maxTurnsPerFocus ?? 6;

    /** @type {Map<string, object>} 每个群的当前话题锁定状态 */
    this.locks = new Map();
  }

  /**
   * 评估一条消息是否属于小鱼感兴趣的话题
   * @param {object} msg 消息对象
   * @returns {{isInteresting: boolean, topic: string, keywords: string[], category: string, score: number}}
   */
  evaluateInterest(msg) {
    const text = String(msg?.text || '').trim();
    if (!text || text.length < 2) {
      return { isInteresting: false, topic: '', keywords: [], category: '', score: 0 };
    }

    // 纯数字、纯符号、系统打卡等无意义杂音一律不感兴趣
    if (/^[0-9]+$/.test(text) || /^[？?！!。，,.]+$/.test(text) || /^(签到|打卡|收到|1|11|111|ok|test)$/i.test(text)) {
      return { isInteresting: false, topic: '', keywords: [], category: '', score: 0 };
    }

    let matchedCat = null;
    let maxScore = 0;
    const hitKeywords = [];

    for (const cat of INTEREST_CATEGORIES) {
      let score = 0;
      const hits = cat.keywords.filter((k) => text.toLowerCase().includes(k.toLowerCase()));
      if (hits.length > 0) {
        score += hits.length * cat.weight;
      }
      if (cat.pattern.test(text)) {
        score += 3.0 * cat.weight;
      }

      if (score > maxScore) {
        maxScore = score;
        matchedCat = cat;
        hitKeywords.push(...hits);
      }
    }

    if (matchedCat && maxScore >= 1.5) {
      const uniqueKw = Array.from(new Set(hitKeywords));
      return {
        isInteresting: true,
        topic: matchedCat.name,
        category: matchedCat.id,
        keywords: uniqueKw.length ? uniqueKw : matchedCat.keywords.slice(0, 10),
        score: maxScore,
      };
    }

    // 动态长文话题探测（如果一句话信息密度高且探讨性强）
    if (text.length >= 10 && /[？?吗呢吧如何怎么]/.test(text)) {
      // 提取核心词（简易去停用词）
      const cleanWords = text
        .replace(/[^\u4e00-\u9fa50-9a-zA-Z]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 2 && !/^(我们|你们|他们|这个|那个|什么|怎么|为什么|是不是|有没有|觉得|可以|现在|今天|就是)$/.test(w));
      if (cleanWords.length >= 2) {
        return {
          isInteresting: true,
          topic: `关于“${cleanWords.slice(0, 3).join('、')}”的群聊探讨`,
          category: 'dynamic',
          keywords: cleanWords.slice(0, 6),
          score: 1.2,
        };
      }
    }

    return { isInteresting: false, topic: '', keywords: [], category: '', score: 0 };
  }

  /**
   * 启动对某个群的话题专注锁定（3分钟）
   * @param {string} groupKey 群聊 key (如 'group:1131460772')
   * @param {object} topicInfo 话题信息
   * @param {object} [initialMsg] 触发首条消息
   */
  startFocus(groupKey, topicInfo, initialMsg = null) {
    if (!groupKey || !topicInfo?.topic) return;
    const now = Date.now();
    const participants = new Set();
    if (initialMsg?.userId) participants.add(String(initialMsg.userId));

    const lock = {
      topic: topicInfo.topic,
      category: topicInfo.category || 'general',
      keywords: Array.from(new Set([...(topicInfo.keywords || [])])),
      startedAt: now,
      expiresAt: now + this.focusWindowMs,
      lastActiveAt: now,
      lastBotReplyAt: now,
      turnsCount: 1,
      participants,
    };

    this.locks.set(groupKey, lock);
    console.log(`[话题专注·锁定] 群 ${groupKey} 开启 3 分钟专注模式: 【${lock.topic}】 (到期: ${new Date(lock.expiresAt).toTimeString().slice(0, 8)})`);
  }

  /**
   * 获取群当前有效的话题锁定状态
   * @param {string} groupKey
   * @returns {object|null}
   */
  getFocus(groupKey) {
    if (!this.locks.has(groupKey)) return null;
    const lock = this.locks.get(groupKey);
    const now = Date.now();

    // 检查是否到期（3分钟超时或超过60秒无人继续）
    if (now >= lock.expiresAt) {
      console.log(`[话题专注·到期] 群 ${groupKey} 话题【${lock.topic}】3分钟专注时间已满，自然沉降退回潜水。`);
      this.locks.delete(groupKey);
      return null;
    }
    if (now - lock.lastActiveAt > this.idleTimeoutMs) {
      console.log(`[话题专注·冷场] 群 ${groupKey} 话题【${lock.topic}】超过 ${Math.round(this.idleTimeoutMs / 1000)} 秒无群友接话，自然退出。`);
      this.locks.delete(groupKey);
      return null;
    }

    return lock;
  }

  /**
   * 检查新进群消息是否符合当前话题专注规则
   * @param {object} msg 群消息
   * @param {boolean} isOwner 是否是老爸
   * @param {boolean} directlyCalled 是否被明确艾特/叫名字
   * @returns {{inLock: boolean, wake: boolean, reason: string, topic?: string}}
   */
  checkMessage(msg, isOwner = false, directlyCalled = false) {
    const groupKey = msg?.key;
    if (!groupKey || !msg?.isGroup) return { inLock: false, wake: false, reason: '' };

    const lock = this.getFocus(groupKey);
    if (!lock) return { inLock: false, wake: false, reason: '' };

    // 1. 最高特权：老爸说话 或 明确被 @ / 拍一拍 / 叫名字，直接放行唤醒
    if (isOwner || directlyCalled) {
      lock.lastActiveAt = Date.now();
      if (msg.userId) lock.participants.add(String(msg.userId));
      return { inLock: true, wake: true, reason: 'topic-priority-override', topic: lock.topic };
    }

    // 2. 检查消息是否属于当前锁定的话题
    const isRelevant = this.#isMessageRelevant(msg, lock);
    if (!isRelevant) {
      // 老爸要求：“其他话题不理”！严格过滤并丢弃
      return { inLock: true, wake: false, reason: 'topic-lock-ignore-unrelated', topic: lock.topic };
    }

    // 3. 命中当前话题：检查微冷却与发言上限
    const now = Date.now();
    if (now - lock.lastBotReplyAt < this.microCooldownMs) {
      // 微冷却中（比如小鱼 5 秒前才刚刚说过一句），给群友留打字反应空间，不秒回抢麦
      return { inLock: true, wake: false, reason: 'topic-micro-cooldown', topic: lock.topic };
    }

    if (lock.turnsCount >= this.maxTurnsPerFocus) {
      console.log(`[话题专注·轮数达标] 群 ${groupKey} 话题【${lock.topic}】已达 ${lock.turnsCount} 轮发言，小鱼克制闭麦。`);
      this.locks.delete(groupKey);
      return { inLock: false, wake: false, reason: 'topic-turns-exhausted' };
    }

    // 放行唤醒！突破常规 90 秒长冷却
    lock.lastActiveAt = now;
    if (msg.userId) lock.participants.add(String(msg.userId));
    return { inLock: true, wake: true, reason: `topic-focus:${lock.topic}`, topic: lock.topic };
  }

  /**
   * 判断单条消息是否属于当前锁定的话题
   */
  #isMessageRelevant(msg, lock) {
    const text = String(msg?.text || '').trim();
    if (!text) return false;

    // 引用了小鱼或者直接回复小鱼上一句话：100% 属于当前话题
    if (msg.isQuoteMe) return true;

    // 命中了该话题的关键词
    const hit = lock.keywords.some((k) => k && text.toLowerCase().includes(k.toLowerCase()));
    if (hit) return true;

    // 检查核心分类模式
    const cat = INTEREST_CATEGORIES.find((c) => c.id === lock.category);
    if (cat && cat.pattern.test(text)) return true;

    // 如果是活跃参与者，且发送了具有承接语气的日常接梗短句（如“确实”、“对啊”、“笑死”、“不至于吧”）
    const isParticipant = msg.userId && lock.participants.has(String(msg.userId));
    const isShortContinuation = /^(确实|对啊|就是|笑死|哈哈+|不是吧|那肯定|真的假的|好家伙|还真是|蚌埠|离谱|不至于|怎么可能|绝了|牛逼|太真实了)/.test(text);
    if (isParticipant && isShortContinuation) {
      return true;
    }

    return false;
  }

  /**
   * 记录小鱼在该话题下的发言
   */
  recordBotReply(groupKey) {
    const lock = this.getFocus(groupKey);
    if (lock) {
      lock.lastBotReplyAt = Date.now();
      lock.turnsCount = (lock.turnsCount || 0) + 1;
      console.log(`[话题专注·跟聊] 群 ${groupKey} 话题【${lock.topic}】小鱼已跟聊 ${lock.turnsCount} 轮`);
    }
  }

  /**
   * 主动解除群话题锁定
   */
  releaseFocus(groupKey) {
    if (this.locks.has(groupKey)) {
      this.locks.delete(groupKey);
      console.log(`[话题专注·手动释放] 群 ${groupKey} 已释放话题锁定。`);
    }
  }
}

export default TopicFocusTracker;
