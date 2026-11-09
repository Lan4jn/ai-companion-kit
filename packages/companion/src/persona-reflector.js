/**
 * 群友自监督人设画像与事实提炼器 (PersonaReflector)
 * ─────────────────────────────────────────────────────────────
 * 核心功能：
 * 1. 监听每次群聊/私聊互动，智能检测群友自我透露或对话里程碑；
 * 2. 异步后台触发轻量级 LLM 反思，提炼群友的性格特质 (traits) 与客观事实档案 (facts)；
 * 3. 自动同步至 memory.js (data/people.json)，供对话上下文与 Web 面板展示；
 * 4. 支持开机平缓回溯无标签的老群友，让群友人设库生动有血有肉。
 */

import fs from 'node:fs';

export class PersonaReflector {
  constructor({ memory, brain, dataDir = './data' } = {}) {
    this.memory = memory;
    this.brain = brain;
    this.dataDir = dataDir;

    this.unreflectedTurns = new Map(); // userId -> 累计未反思轮数
    this.lastReflectedAt = new Map();  // userId -> 上次反思时间戳
    this.queue = [];                   // 待反思队列
    this.processing = false;

    // 常用自我透露信号正则（第一人称 + 生活/硬件/经历动词）
    this.revealRegex = /(我|自己|老子|本大爷|咱|俺)(是|在|住|买|用|玩|换|考|学|做|欠|有一只|有一台|有只|有台|天天|经常|喜欢|讨厌|老家|工作|大专|大学|结婚|辞职|提桶|生病|住院|显卡|手机|电脑|平板|猫|狗)/i;
  }

  /**
   * 在每轮对话结束后评估是否需要触发异步画像反思
   */
  consider(userId, { name = '', text = '', reply = '', isGroup = true } = {}) {
    const uid = String(userId || '').trim();
    if (!uid || uid === 'self' || uid === 'system' || uid === '123456') return;

    const count = (this.unreflectedTurns.get(uid) || 0) + 1;
    this.unreflectedTurns.set(uid, count);

    // 冷却时间控制：同一用户 3 分钟内最多反思 1 次
    const lastAt = this.lastReflectedAt.get(uid) || 0;
    if (Date.now() - lastAt < 180_000) return;

    const p = this.memory?.person?.(uid);
    const hasZeroTraits = !p || (!p.traits?.length && !p.facts?.length);

    // 触发条件：
    // 1. 发言包含高置信度自我透露信号
    // 2. 该用户为白板且已互动 >= 2 次
    // 3. 累计未反思轮数达到 5 轮
    const isReveal = typeof text === 'string' && this.revealRegex.test(text);
    const isMilestone = count >= 5;
    const isFreshWhiteboard = hasZeroTraits && (p?.interactions || count) >= 2;

    if (isReveal || isMilestone || isFreshWhiteboard) {
      this.enqueue(uid, name || p?.name || uid);
    }
  }

  /**
   * 加入后台异步反思队列
   */
  enqueue(userId, name = '') {
    const uid = String(userId);
    if (this.queue.some((j) => j.userId === uid)) return;
    this.queue.push({ userId: uid, name });
    this.drainQueue();
  }

  async drainQueue() {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const job = this.queue.shift();
      try {
        await this.reflectUser(job.userId, job.name);
      } catch (err) {
        console.error(`[PersonaReflector] 反思群友【${job.name || job.userId}】失败:`, err?.message || err);
      }
      // 任务间隔 1.5 秒，避免突发高频请求
      await new Promise((r) => setTimeout(r, 1500));
    }

    this.processing = false;
  }

  /**
   * 针对单个群友执行画像反思与沉淀
   */
  async reflectUser(userId, name = '') {
    if (!this.memory || !this.brain || typeof this.brain.complete !== 'function') return;
    const uid = String(userId);
    const p = this.memory.person(uid, { name });
    if (!p) return;

    const topics = p.topics || [];
    if (topics.length === 0) return;

    // 取最近 6 轮真实对话，显式拆解发言人
    const formatted = topics.slice(-6).map((t, idx) => {
      const parts = String(t).split(' → ');
      const q = parts[0] ? parts[0].trim() : '';
      const a = parts[1] ? parts[1].trim() : '';
      return `[第${idx + 1}轮]\n群友说：“${q}”\n小鱼回复：“${a}”`;
    }).join('\n\n');

    const existingTraits = (p.traits || []).join('、') || '暂无';
    const existingFacts = (p.facts || []).join('；') || '暂无';

    const prompt = `你负责帮小肥鱼（QQ群里的AI伴侣，性格娇憨、爱吃、爱怼人）提炼群友的画像记忆。
目标群友：${p.name || name || uid} (QQ: ${uid})
已知已有特质：${existingTraits}
已知已有事实：${existingFacts}

【最近真实对话历史】：
${formatted}

【核心注意事项】：
1. 【小鱼回复】是小鱼自己说的话（例如小鱼说“我自己都没吃饱，奥利奥早进肚子了”，这绝对不是群友吃的），严禁把小鱼的话安到群友头上！
2. 只有【群友说】的内容才是该群友本人的真实言行！

请提炼关于【该群友本人】的最新画像与事实：
严格按以下 JSON 结构输出：
{
  "traits": ["2~6字性格/风格标签"],
  "facts": ["关于该群友的真实事实档案"],
  "pending": []
}

说明：
- traits：性格标签（如“数码折腾党”、“老梗爱好者”、“调皮群友”、“二游非酋”、“重度加班社畜”），仅提炼群友体现出的真实性格；
- facts：事实档案（如“群名片含一加13”、“喜欢拿金坷垃台词考小鱼”、“在备考单招”、“养了只英短”、“欠小鱼两盒鸡米花”），必须是对方言行透露的明确事实，严禁瞎猜脑补；
- pending：若有双方约定好的未办事项则写入，无则空数组；
- 若无新的有效信息，返回空数组。不要复述已有事实。`;

    const raw = await this.brain.complete({
      prompt,
      json: true,
      temperature: 0.3,
      max_tokens: 1200,
    });

    if (!raw) return;

    let parsed = null;
    try {
      parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      return;
    }

    if (!parsed) return;

    let addedCount = 0;
    if (Array.isArray(parsed.traits)) {
      for (const tr of parsed.traits) {
        const clean = String(tr || '').replace(/\s+/g, ' ').trim().slice(0, 16);
        if (clean && clean.length >= 2 && !p.traits.includes(clean)) {
          this.memory.remember(uid, { trait: clean });
          addedCount++;
        }
      }
    }

    if (Array.isArray(parsed.facts)) {
      for (const f of parsed.facts) {
        const clean = String(f || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        if (clean && clean.length >= 4 && !p.facts.includes(clean)) {
          this.memory.remember(uid, { fact: clean });
          addedCount++;
        }
      }
    }

    if (Array.isArray(parsed.pending)) {
      for (const pd of parsed.pending) {
        const clean = String(pd || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        if (clean && clean.length >= 4 && !p.pending.includes(clean)) {
          this.memory.remember(uid, { pending: clean });
          addedCount++;
        }
      }
    }

    this.lastReflectedAt.set(uid, Date.now());
    this.unreflectedTurns.set(uid, 0);

    if (addedCount > 0) {
      console.log(`[PersonaReflector] 已为群友【${p.name || uid}】(${uid}) 沉淀 ${addedCount} 条画像档案！`);
    }
  }

  /**
   * 开机平缓回溯已有老群友的画像
   */
  bootstrap({ limit = 20 } = {}) {
    if (!this.memory) return;
    try {
      const all = this.memory.peopleFile ? JSON.parse(fs.readFileSync(this.memory.peopleFile, 'utf8')) : {};
      const candidates = Object.entries(all)
        .filter(([uid, p]) => {
          if (uid === '578021239' || uid === '123456' || uid === 'self' || uid === 'system') return false;
          const noTraits = (!p.traits || p.traits.length === 0) && (!p.facts || p.facts.length === 0);
          const hasTopics = Array.isArray(p.topics) && p.topics.length >= 2;
          return noTraits && hasTopics;
        })
        .sort((a, b) => (b[1].interactions || 0) - (a[1].interactions || 0))
        .slice(0, limit);

      if (candidates.length > 0) {
        console.log(`[PersonaReflector] 发现 ${candidates.length} 位活跃白板群友，启动平缓人设画像回溯...`);
        for (const [uid, p] of candidates) {
          this.enqueue(uid, p.name || uid);
        }
      }
    } catch (e) {
      console.error('[PersonaReflector] 回溯老群友失败:', e?.message || e);
    }
  }
}
