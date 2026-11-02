/**
 * 记忆账本 · 按「人」存，而不是按「会话」存
 * ─────────────────────────────────────────────────────────────
 * 大多数聊天机器人把记忆按会话存：私聊一份、群聊一份、不同群各一份。
 * 结果就是同一个人换了地方，AI 就"不认识"他了。
 *
 * 这里换一种做法：**所有记忆都挂在人身上**（用 QQ 号当 key）。
 * 不管他出现在私聊、群 A 还是群 B，读写的都是同一本账。
 *
 * 账本里存什么：
 *   traits        你了解他的性格/习惯     "常熬夜" "嘴上嫌我笨其实一直给我加功能"
 *   facts         他告诉过你的事实         "他的 QQ 是 123456"
 *   topics        你们聊过的话题（滚动）   "凌晨他说通了"
 *   pending       他心里还没说出口的事
 *   interactions  互动过多少次
 *   firstSeenAt / lastSeenAt
 *
 * 另外还有一个「共享对话流」：把各个场合的真实一来一回按时间排成一条线。
 * 唤醒时把最近 N 条喂给模型，它就知道"刚才在别处发生了什么"。
 */
import fs from 'node:fs';
import path from 'node:path';

export class Memory {
  /**
   * @param {object} opts
   * @param {string} opts.dir            数据目录
   * @param {number} [opts.maxTopics]    每人最多留多少条话题
   * @param {number} [opts.maxTurns]     共享对话流最多留多少条
   */
  constructor({ dir, maxTopics = 50, maxTurns = 5000 } = {}) {
    this.dir = dir;
    this.peopleFile = path.join(dir, 'people.json');
    this.turnsFile = path.join(dir, 'turns.jsonl');
    this.maxTopics = maxTopics;
    this.maxTurns = maxTurns;
    fs.mkdirSync(dir, { recursive: true });
  }

  // ── 底层读写 ────────────────────────────────────────────────
  #readAll() {
    try { return JSON.parse(fs.readFileSync(this.peopleFile, 'utf8')); } catch { return {}; }
  }
  #writeAll(j) {
    fs.writeFileSync(this.peopleFile, JSON.stringify(j, null, 2), 'utf8');
  }

  /** 取某个人的账（不存在就建） */
  person(id, { name } = {}) {
    const all = this.#readAll();
    const key = String(id);
    if (!all[key]) {
      all[key] = {
        name: name || key,
        traits: [], facts: [], topics: [], pending: [],
        interactions: 0,
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now(),
      };
      this.#writeAll(all);
    }
    const p = all[key];
    // 补字段（老数据兼容）
    for (const k of ['traits', 'facts', 'topics', 'pending']) if (!Array.isArray(p[k])) p[k] = [];
    if (name && p.name !== name) { p.name = name; this.#writeAll(all); }
    return p;
  }

  /** 往某人账上写一条 */
  remember(id, { trait, fact, topic, pending, name } = {}) {
    const all = this.#readAll();
    const key = String(id);
    if (!all[key]) {
      all[key] = { name: name || key, traits: [], facts: [], topics: [], pending: [], interactions: 0, firstSeenAt: Date.now(), lastSeenAt: Date.now() };
    }
    const p = all[key];
    for (const k of ['traits', 'facts', 'topics', 'pending']) if (!Array.isArray(p[k])) p[k] = [];
    if (name) p.name = String(name).slice(0, 40);

    const put = (arr, v) => {
      const s = String(v || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      if (!s) return;
      const i = arr.indexOf(s);
      if (i >= 0) arr.splice(i, 1);      // 提过的挪到最新
      arr.push(s);
    };

    if (trait) put(p.traits, trait);
    if (fact) put(p.facts, fact);
    if (topic) put(p.topics, topic);
    if (pending) put(p.pending, pending);

    while (p.topics.length > this.maxTopics) p.topics.shift();
    while (p.traits.length > 40) p.traits.shift();
    while (p.facts.length > 60) p.facts.shift();
    while (p.pending.length > 12) p.pending.shift();

    p.lastSeenAt = Date.now();
    p.interactions = (Number(p.interactions) || 0) + 1;
    this.#writeAll(all);
    return p;
  }

  /** 记一次互动（不加内容，只涨计数） */
  touch(id, { name } = {}) {
    const all = this.#readAll();
    const key = String(id);
    if (!all[key]) return this.remember(key, { name });
    all[key].lastSeenAt = Date.now();
    all[key].interactions = (Number(all[key].interactions) || 0) + 1;
    if (name) all[key].name = String(name).slice(0, 40);
    this.#writeAll(all);
  }

  // ── 共享对话流 ──────────────────────────────────────────────
  /**
   * 记一轮对话。where 用来说明发生在哪（'private' / 'group:123' / 任意标记）
   */
  logTurn({ where, who, text, reply }) {
    const rec = {
      t: Date.now(),
      where: String(where || ''),
      who: String(who || '').slice(0, 30),
      text: String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300),
      reply: String(reply || '').replace(/\s+/g, ' ').trim().slice(0, 300),
    };
    if (!rec.text && !rec.reply) return;
    try {
      fs.appendFileSync(this.turnsFile, JSON.stringify(rec) + '\n', 'utf8');
      // 太长就裁
      const lines = fs.readFileSync(this.turnsFile, 'utf8').trim().split('\n');
      if (lines.length > this.maxTurns) {
        fs.writeFileSync(this.turnsFile, lines.slice(-this.maxTurns).join('\n') + '\n', 'utf8');
      }
    } catch { /* 写失败不影响主流程 */ }
  }

  /** 取指定会话 key 的最近真实对话历史（用于连续对话上下文记忆） */
  sessionTurns(key, n = 12) {
    if (!key) return [];
    let rows = [];
    try {
      rows = fs.readFileSync(this.turnsFile, 'utf8').trim().split('\n')
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    } catch { return []; }
    return rows.filter((r) => r.where === key).slice(-n);
  }

  /** 取最近 n 轮（可按来源过滤） */
  recentTurns(n = 20, { excludeWhere, sinceMs } = {}) {
    let rows = [];
    try {
      rows = fs.readFileSync(this.turnsFile, 'utf8').trim().split('\n')
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    } catch { return []; }
    if (sinceMs) rows = rows.filter((r) => Date.now() - r.t < sinceMs);
    if (excludeWhere) rows = rows.filter((r) => !String(r.where || '').startsWith(excludeWhere));
    return rows.slice(-n);
  }

  /**
   * 关联回忆：按关键词从历史长程对话中检索相关的聊天记录（排除已在最近滑窗里的记录）
   */
  recallTurns(query, { where, limit = 4, excludeRecent = 80 } = {}) {
    try {
      const q = String(query || '').trim().toLowerCase();
      if (!q || q.length < 2) return [];
      const stopWords = new Set(['你', '我', '他', '她', '它', '在', '了', '的', '呢', '吗', '吧', '这', '那', '有', '个', '是', '也', '不', '去', '说', '啊', '哦', '嗯', '么', '着', '得', '到', '事', '会']);
      const clean = q.replace(/[\s,，。？?！!、～~“”"'…\-_]+/g, ' ').trim();
      const tokens = new Set();
      for (const segment of clean.split(' ')) {
        if (!segment) continue;
        if (segment.length >= 2) {
          tokens.add(segment);
          for (let i = 0; i < segment.length - 1; i++) {
            const bi = segment.slice(i, i + 2);
            if (!stopWords.has(bi[0]) || !stopWords.has(bi[1])) tokens.add(bi);
          }
        }
        for (const ch of segment) {
          if (!stopWords.has(ch)) tokens.add(ch);
        }
      }
      const words = Array.from(tokens);
      if (!words.length) return [];
      const rows = fs.readFileSync(this.turnsFile, 'utf8').trim().split('\n')
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
      const pool = excludeRecent > 0 ? rows.slice(0, -excludeRecent) : rows;
      const scored = [];
      for (const r of pool) {
        if (where && r.where !== where) continue;
        const text = `${r.text || ''} ${r.reply || ''}`.toLowerCase();
        let score = 0;
        for (const w of words) {
          if (text.includes(w)) score += (w.length >= 2 ? 3 : 1);
        }
        if (score >= 2) scored.push({ r, score });
      }
      scored.sort((a, b) => b.score - a.score || b.r.t - a.r.t);
      return scored.slice(0, limit).map((x) => x.r);
    } catch { return []; }
  }

  // ── 给提示词用 ──────────────────────────────────────────────
  /** 把某人的账渲染成一段可注入的文字 */
  renderPerson(id) {
    const p = this.#readAll()[String(id)];
    if (!p) return '';
    const L = [];
    if (p.traits?.length) L.push('你了解他：' + p.traits.slice(-12).join('；'));
    if (p.facts?.length) L.push('他告诉过你：' + p.facts.slice(-15).join('；'));
    if (p.topics?.length) L.push('你们聊过：' + p.topics.slice(-16).join('；'));
    if (p.pending?.length) L.push('⚠️ 你心里还记着没说出口的事：' + p.pending.slice(-4).join('；'));
    if (p.interactions) L.push('你们互动过 ' + p.interactions + ' 次');
    if (!L.length) return '';
    return '【关于 ' + (p.name || id) + '（' + id + '）的一本账】\n' + L.join('\n') + '\n';
  }

  // ── 小鱼自主生活日记与经历沉淀 ─────────────────────────────
  /**
   * 记录一条生活日记/事件经历到持久化记忆中
   */
  logDiary({ category = '日常', activity = '', details = '', mood = '' }) {
    const rec = {
      t: Date.now(),
      category: String(category).slice(0, 20),
      activity: String(activity).slice(0, 40),
      details: String(details).slice(0, 150),
      mood: String(mood).slice(0, 150),
    };
    if (!rec.activity && !rec.details) return;
    try {
      const diaryFile = path.join(this.dir, 'diary.jsonl');
      fs.appendFileSync(diaryFile, JSON.stringify(rec) + '\n', 'utf8');
      const lines = fs.readFileSync(diaryFile, 'utf8').trim().split('\n');
      if (lines.length > 200) {
        fs.writeFileSync(diaryFile, lines.slice(-150).join('\n') + '\n', 'utf8');
      }
    } catch {}
  }

  /**
   * 取最近 n 条生活经历
   */
  recentDiary(n = 6) {
    try {
      const diaryFile = path.join(this.dir, 'diary.jsonl');
      const lines = fs.readFileSync(diaryFile, 'utf8').trim().split('\n');
      return lines.map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean).slice(-n);
    } catch {
      return [];
    }
  }

  /**
   * 渲染为提示词文本注入大脑
   */
  renderDiary(n = 6) {
    const list = this.recentDiary(n);
    if (!list.length) return '';
    const lines = list.map(r => {
      const d = new Date(r.t);
      const timeStr = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      return `· ${timeStr} [${r.category}] ${r.details}（${r.mood}）`;
    });
    return '【小鱼的生活经历日记（你今天真实经历过的点滴，有真实回忆）】\n' + lines.join('\n')
      + '\n（老爸或群友问起你今天干嘛了、之前在玩啥，你可以自然调取这些真实记忆如实分享）\n';
  }

  // ── 群聊潜水与群上下文记忆 ─────────────────────────────────
  /**
   * 记录群聊消息（即使小鱼潜水没回复，也沉淀下来作为环境背景）
   */
  logGroupChatter({ groupKey, userId, name, text }) {
    if (!groupKey || !text) return;
    const cleanText = String(text).replace(/\s+/g, ' ').trim().slice(0, 200);
    const cleanName = String(name || userId).slice(0, 30);
    const rec = {
      t: Date.now(),
      group: String(groupKey),
      userId: String(userId),
      name: cleanName,
      text: cleanText,
    };

    try {
      const chatterFile = path.join(this.dir, 'group-chatter.jsonl');
      fs.appendFileSync(chatterFile, JSON.stringify(rec) + '\n', 'utf8');
      const lines = fs.readFileSync(chatterFile, 'utf8').trim().split('\n');
      if (lines.length > 2000) {
        fs.writeFileSync(chatterFile, lines.slice(-1500).join('\n') + '\n', 'utf8');
      }
    } catch {}

    // 如果群聊提到了核心梗（如姐夫、炸弹机、装机、或者老爸说话），自动记入生活日记
    if (/姐夫|炸弹机|电源|2060/i.test(cleanText)) {
      this.logDiary({
        category: '群聊',
        activity: '群友玩梗',
        details: `${cleanName}在群里又提起姐夫和炸弹机的话题`,
        mood: '潜水看群友吐槽姐夫的装机名场面，笑得肚子疼'
      });
    }
  }

  /**
   * 取指定群或全群最近潜水看到的群聊流
   */
  recentGroupChatter(groupKey = null, n = 200) {
    try {
      const chatterFile = path.join(this.dir, 'group-chatter.jsonl');
      const lines = fs.readFileSync(chatterFile, 'utf8').trim().split('\n');
      let rows = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      if (groupKey) {
        rows = rows.filter(r => r.group === groupKey);
      }
      return rows.slice(-n);
    } catch {
      return [];
    }
  }

  /**
   * 把群聊潜水流渲染成上下文提示词
   */
  renderGroupChatter(groupKey = null, n = 200) {
    const rows = this.recentGroupChatter(groupKey, n);
    if (!rows.length) return '';
    const lines = rows.map(r => {
      const timeStr = new Date(r.t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      return `  [${timeStr}] ${r.name}：${r.text}`;
    });
    return `【群聊前文脉络背景流（你潜水看到的最近 ${lines.length} 条群消息，仅供了解来龙去脉与话题演变，严禁挑选前文旧消息回复，必须针对末尾最新发言回复）：】\n` + lines.join('\n') + '\n';
  }

  /** 把最近对话渲染成一段可注入的文字 */
  renderRecent(n = 20, opts = {}) {
    const rows = this.recentTurns(n, opts);
    if (!rows.length) return '';
    const lines = rows.map((r) => {
      const when = new Date(r.t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      const place = r.where.startsWith('group') ? '群里' : '私聊';
      const parts = [];
      if (r.text) parts.push(r.who + '（' + place + '）：' + r.text);
      if (r.reply) parts.push('你：' + r.reply);
      return '  ' + when + '  ' + parts.join('\n        ');
    });
    return '【最近的真实对话（跨场合合在一起）】\n' + lines.join('\n')
      + '\n（这些是真说过的，别装作不知道，也别生硬复述）\n';
  }

  /** 导出（调试/备份用） */
  dump() {
    return { people: this.#readAll(), turns: this.recentTurns(1e9) };
  }
}
