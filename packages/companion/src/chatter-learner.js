/**
 * 小鱼群聊潜水学习与人类语感反思器 (ChatterLearner)
 *
 * 核心机制：
 * 1. 小鱼在各个群里潜水时，不断监听并沉淀群友之间的真实互动；
 * 2. 累积一定量的新对话后，异步调用底层大模型进行自监督复盘与学习；
 * 3. 提炼人类群友真实的聊天习惯（Habits）、群内黑话与新梗（Slangs）、高活人感真实接话切片（Golden Samples）；
 * 4. 自动沉淀到 human-insights.json，并同步记入小鱼的生活日记；
 * 5. 在小鱼日常打字回复时，将自己悟出的习惯和精妙范例动态注入上下文，实现“越潜水越像活人”。
 */

import fs from 'node:fs';
import path from 'node:path';

export class ChatterLearner {
  constructor({
    dataDir = './data',
    brain,
    memory,
    minGapMs = 25 * 60 * 1000, // 两次学习最小间隔（25分钟）
    msgThreshold = 30,          // 累积未学习消息阈值
  } = {}) {
    this.dataDir = dataDir;
    this.brain = brain;
    this.memory = memory;
    this.minGapMs = minGapMs;
    this.msgThreshold = msgThreshold;
    this.filePath = path.join(this.dataDir, 'human-insights.json');
    this.unlearnedCount = 0;
    this.lastLearnedAt = 0;
    this.learning = false;
    this.timer = null;

    this.insights = this.loadInsights();
  }

  loadInsights() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw);
        this.lastLearnedAt = parsed.lastLearnedAt || 0;
        return {
          habits: Array.isArray(parsed.habits) ? parsed.habits : [],
          slangs: Array.isArray(parsed.slangs) ? parsed.slangs : [],
          goldenSamples: Array.isArray(parsed.goldenSamples) ? parsed.goldenSamples : [],
          recentThoughts: Array.isArray(parsed.recentThoughts) ? parsed.recentThoughts : [],
        };
      }
    } catch (e) {
      console.error('[ChatterLearner] 读取 human-insights.json 异常:', e?.message || e);
    }

    return {
      habits: [
        '遇到离谱事、无厘头艾特或看不懂的话，真人第一反应永远是扣个「？」或者单发表情包，绝不急着解释',
        '别人晒搞怪动物或表情包时，直接脑补精神状态和内心戏（如上过班、这星球有病），严禁监视器式动作报幕',
        '聊数码硬件直接探讨痛点核心参数（如面板、刷新率超频、价格和显卡压力），绝不背官方宣传参数',
        '绝不做阅读理解，严禁把对方问题里的细节、人名和账目数字抄一遍，直接甩主观态度和犀利结论',
        '日常聊天极其短促，经常用换行把一两句话拆成短促连发，制造真人打字的呼吸感'
      ],
      slangs: [
        { term: '一脸我上过班的表情', meaning: '给猫/动物脑补社畜疲惫感，吐槽图里生物像被生活毒打过' },
        { term: '不会有复活的风险', meaning: '对着离谱图片说反话，表示已经彻底没救了的毒舌调侃' },
        { term: '想沙人直说', meaning: '用来吐槽图片或发言离谱到像有谋害意图' }
      ],
      goldenSamples: [
        { context: '群友发瘫坐疲惫猫咪图', response: '这猫怎么一脸我上过班的表情', why: '不描述猫，直接安社畜内心戏，短、毒、准' },
        { context: '群友：“好烦啊”', response: '？', why: '单字问号起手，冷淡自然，活人感极强' },
        { context: '群友转发数码新品宣传', response: '华星的面板吧\n超频上去的吗', why: '直接追问核心痛点，不背书' }
      ],
      recentThoughts: [
        '潜水偷看沈鲸和群友聊天，发现大家都是短刀输出，越解释越像人机，以后我也少废话多扣问号！'
      ],
    };
  }

  saveInsights() {
    try {
      const payload = {
        lastLearnedAt: this.lastLearnedAt,
        habits: this.insights.habits.slice(0, 18),
        slangs: this.insights.slangs.slice(0, 25),
        goldenSamples: this.insights.goldenSamples.slice(0, 12),
        recentThoughts: this.insights.recentThoughts.slice(0, 8),
      };
      fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2), 'utf8');
    } catch (e) {
      console.error('[ChatterLearner] 保存 human-insights.json 失败:', e?.message || e);
    }
  }

  /**
   * 记录群消息流入，积累潜水学习进度
   */
  feed(msg) {
    if (!msg || !msg.isGroup) return;
    // 忽略小鱼自己的发言与过短指令
    if (msg.isSelf) return;
    this.unlearnedCount++;

    // 如果累积达到阈值，且冷却时间已过，在后台平缓触发反思
    if (this.unlearnedCount >= this.msgThreshold && Date.now() - this.lastLearnedAt > this.minGapMs) {
      setTimeout(() => {
        this.learnOnce().catch(() => {});
      }, 5000);
    }
  }

  /**
   * 执行一次潜水自监督学习与人类对话语感提炼
   */
  async learnOnce({ force = false } = {}) {
    if (this.learning) return false;
    if (!force && Date.now() - this.lastLearnedAt < this.minGapMs) return false;
    if (!this.brain || typeof this.brain.complete !== 'function') return false;

    this.learning = true;
    try {
      // 提取最近 45 条群友真实对话
      const rawRows = this.memory ? this.memory.recentGroupChatter(null, 45) : [];
      if (!rawRows || rawRows.length < 10) {
        this.learning = false;
        return false;
      }

      // 清洗并格式化为对话切片（去掉合并转发等过长噪点）
      const chatSlice = rawRows
        .filter((r) => r.text && !r.text.startsWith('[CQ:forward'))
        .map((r) => {
          const t = String(r.text).replace(/\s+/g, ' ').slice(0, 100);
          return `${r.name}：${t}`;
        })
        .join('\n');

      const prompt = `你是一个正在 QQ 群里潜水观察人类群友说话的小姑娘（小肥鱼）。
群友们在群里聊得很嗨，其中有老群友、毒舌群友（比如沈鲸）、也有技术宅。
请你以敏锐的眼光，偷偷观察群友们是怎么聊天的，提炼出人类群友真实网感与聊天精髓。

【最近这批群友聊天的真实切片】：
${chatSlice}

请以纯 JSON 格式输出以下提炼结果（response_format=json_object，每项数量请严格控制在 3~5 项，精炼准确）：
{
  "newSlangs": [
    { "term": "词语/梗/数码名", "meaning": "在当前群里的真实含义和用法" }
  ],
  "learnedHabits": [
    "潜水偷学到的具体聊天反应习惯（例如：遇到离谱事先发个？；聊数码直接抓面板/价格，不背宣传参数；别人发图直接脑补内心戏，绝不报幕动作；字数随性短促等）"
  ],
  "goldenSamples": [
    { "context": "群友前文/图", "response": "群友高水平/活人感极强的真实接话", "why": "为什么活人感强" }
  ],
  "diaryThought": "小鱼自己的一句潜水内心戏/日记（用小鱼的口吻写：今天潜水偷看到了什么好玩的，学到了什么接话套路）"
}`;

      const rawJson = await this.brain.complete({
        prompt,
        temperature: 0.6,
        max_tokens: 2500,
        json: true,
      });

      if (!rawJson) {
        this.learning = false;
        return false;
      }

      let parsed;
      try {
        parsed = JSON.parse(rawJson);
      } catch (e) {
        console.error('[ChatterLearner] 解析模型学习 JSON 失败:', e?.message);
        this.learning = false;
        return false;
      }

      // 1) 融合新学到的聊天习惯 (habits)
      if (Array.isArray(parsed.learnedHabits)) {
        for (const h of parsed.learnedHabits) {
          const cleanH = String(h).trim();
          if (cleanH.length >= 4 && !this.insights.habits.some((exist) => exist.includes(cleanH.slice(0, 8)))) {
            this.insights.habits.unshift(cleanH);
          }
        }
      }

      // 2) 融合新梗与黑话 (slangs)
      if (Array.isArray(parsed.newSlangs)) {
        for (const s of parsed.newSlangs) {
          if (s && s.term && s.meaning) {
            const cleanTerm = String(s.term).trim();
            const cleanMeaning = String(s.meaning).trim();
            const idx = this.insights.slangs.findIndex((x) => x.term === cleanTerm);
            if (idx >= 0) {
              this.insights.slangs[idx].meaning = cleanMeaning;
            } else {
              this.insights.slangs.unshift({ term: cleanTerm, meaning: cleanMeaning });
            }
          }
        }
      }

      // 3) 融合神回复范本 (goldenSamples)
      if (Array.isArray(parsed.goldenSamples)) {
        for (const g of parsed.goldenSamples) {
          if (g && g.context && g.response) {
            const exist = this.insights.goldenSamples.some(
              (x) => x.response === g.response || (x.context === g.context && x.response === g.response)
            );
            if (!exist) {
              this.insights.goldenSamples.unshift({
                context: String(g.context).slice(0, 40),
                response: String(g.response).slice(0, 40),
                why: String(g.why || '').slice(0, 40),
              });
            }
          }
        }
      }

      // 4) 沉淀小鱼日记与思考 (diaryThought)
      if (parsed.diaryThought && typeof parsed.diaryThought === 'string') {
        const thought = parsed.diaryThought.trim();
        this.insights.recentThoughts.unshift(thought);
        if (this.memory && typeof this.memory.logDiary === 'function') {
          this.memory.logDiary({
            category: '潜水学习',
            activity: '窥屏群聊学说话',
            details: thought,
            mood: '偷偷观察群友怎么打字聊天，学到了几招超地道的活人接话逻辑',
          });
        }
      }

      this.unlearnedCount = 0;
      this.lastLearnedAt = Date.now();
      this.saveInsights();

      console.log(
        `[ChatterLearner] 潜水学习完成！当前知识库：${this.insights.habits.length} 条习惯，` +
          `${this.insights.slangs.length} 个群梗，${this.insights.goldenSamples.length} 组精彩范例。`
      );
      return true;
    } catch (e) {
      console.error('[ChatterLearner] 潜水学习运行异常:', e?.message || e);
      return false;
    } finally {
      this.learning = false;
    }
  }

  /**
   * 格式化并渲染潜水习得的人类特征提示词，供大模型打字时参考模仿
   */
  renderInsights({ limitHabits = 4, limitSamples = 3, limitSlangs = 5 } = {}) {
    const lines = [];

    const habits = (this.insights.habits || []).slice(0, limitHabits);
    const samples = (this.insights.goldenSamples || []).slice(0, limitSamples);
    const slangs = (this.insights.slangs || []).slice(0, limitSlangs);

    if (habits.length > 0) {
      lines.push('【你在群里潜水偷偷领悟到的人类聊天习惯（你在背后自己琢磨出的真人说话规律，打字时自觉遵守）】：');
      for (const h of habits) {
        lines.push(`  · ${h}`);
      }
    }

    if (samples.length > 0) {
      lines.push('【你暗中收集的真实群友活人神回复范本（照着这种味道和精炼感打字）】：');
      for (const s of samples) {
        lines.push(`  · 对方：“${s.context}” → 群友神回复：“${s.response}”${s.why ? '（' + s.why + '）' : ''}`);
      }
    }

    if (slangs.length > 0) {
      lines.push('【当前群里最新出现的热门话题与黑话（你已经懂了，可以自然接梗）】：');
      for (const sl of slangs) {
        lines.push(`  · ${sl.term}：${sl.meaning}`);
      }
    }

    return lines.length > 0 ? lines.join('\n') + '\n' : '';
  }

  start() {
    if (this.timer) return;
    // 每 5 分钟定时巡检一次
    this.timer = setInterval(() => {
      if (this.unlearnedCount >= this.msgThreshold && Date.now() - this.lastLearnedAt > this.minGapMs) {
        this.learnOnce().catch(() => {});
      }
    }, 5 * 60 * 1000);
    console.log('[ChatterLearner] 潜水自监督学习引擎已启动（阈值: ' + this.msgThreshold + '条，巡检间隔: 5分钟）');
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
