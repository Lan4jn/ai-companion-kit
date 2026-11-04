/**
 * 成长记忆 —— 群友怎么对她，她就怎么改。
 *
 * 跟 chatter-learner 的分工：
 *   chatter-learner  学「别人怎么说话」，产出说话风格
 *   growth           学「别人怎么对她」，产出行为约束
 *
 * 关键：批评不是记成"有人嫌过你"，而是提炼成"以后别做X"。
 * 原始批评攒够 3 条就让模型归纳一次，结果进 avoidRules 注入 prompt。
 * 夸的只记录不生成规则，免得越夸越飘。
 *
 * 落盘：
 *   data/growth.jsonl       每条事件一行（原话，用于复盘）
 *   data/self-image.json    提炼后的 avoidRules + 计数
 */

import fs from 'node:fs';
import path from 'node:path';

// 群友在夸她
const PRAISE = /(厉害|牛啊|牛哇|牛逼|666|太强|真会|说得好|说得对|笑死|哈哈{2,}|可爱|懂事|聪明|有道理|服了|学到了|宝藏|真棒|好玩|有意思|绝了|真行|可以啊)/;
// 群友在嫌她（单字词已拆成词组，避免"滚烫""笨鱼"误伤）
const CRITICISM = /(闭嘴|滚吧|滚蛋|滚开|烦死|真烦|有点烦|傻子|太傻|真傻|蠢死|别说了|什么鬼|你懂个屁|胡说|扯淡|离谱|没用的东西|别乱说|住嘴|够了|说话太冲|太凶了|别阴阳|别装|少来|答非所问|没听懂|说人话|别岔开|又跑题|听不懂人话)/;
// 特殊事件：问她身份、考她、让她干活
const INCIDENT = /(你是谁|你主人|你爸|谁做的|什么模型|你是\s*ai|测试|考你|你会什么|你能干嘛|谁的小鱼|你几岁|你哪来的)/;

const MAX_OWN = 300;          // 记住最近 300 条自己说的话，用于匹配回应
const MAX_EVENTS = 800;       // growth.jsonl 最多留这么多行
const DISTILL_EVERY = 3;      // 攒够 3 条批评就归纳一次
const MAX_RULES = 8;          // 最多留 8 条行为约束

let dir = '';
let brainRef = null;
let ownMessages = [];
let events = [];
let pendingCriticism = [];
let distilling = false;
let selfImage = {
  counts: { praise: 0, criticism: 0, incident: 0 },
  avoidRules: [],
  traits: [],
  updatedAt: 0,
};
let enabled = true;

export function initGrowth({ dataDir, cfg, brain } = {}) {
  dir = dataDir || path.join(process.cwd(), 'data');
  brainRef = brain || null;
  enabled = cfg?.enabled !== false;
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}

  try {
    const f = path.join(dir, 'growth.jsonl');
    if (fs.existsSync(f)) {
      const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
      events = lines.slice(-MAX_EVENTS).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    }
  } catch {}

  try {
    const f = path.join(dir, 'self-image.json');
    if (fs.existsSync(f)) {
      const saved = JSON.parse(fs.readFileSync(f, 'utf8'));
      selfImage = { ...selfImage, ...saved, avoidRules: saved.avoidRules || [] };
    }
  } catch {}

  console.log(`[Growth] 已加载：${events.length} 条事件，${selfImage.avoidRules.length} 条行为约束`);
}

/** 她发出去一条消息，登记下来等回应 */
export function observeOwn({ chatKey, messageId, text, at, replyToUid } = {}) {
  if (!enabled || !messageId) return;
  ownMessages.push({ messageId: String(messageId), chatKey, text: String(text || ''), at: at || Date.now(), replyToUid: String(replyToUid || '') });
  if (ownMessages.length > MAX_OWN) ownMessages = ownMessages.slice(-MAX_OWN);
}

/** 别人发来一条消息：判断是不是在说她 */
export function observeIncoming(msg, selfId = '') {
  if (!enabled || !msg) return;
  const text = String(msg.text || '');
  if (!text) return;

  // 1. 是不是在回应她
  let hit = null;
  if (msg.replyTo) hit = ownMessages.find((m) => m.messageId === String(msg.replyTo));
  if (!hit && selfId) {
    const raw = JSON.stringify(msg.raw || []);
    if (raw.includes(`qq=${selfId}`) || raw.includes(`"qq":"${selfId}"`)) hit = { text: '' };
  }
  if (!hit && /(小鱼|小肥鱼|鱼形RBQ)/.test(text)) hit = { text: '' };
  if (!hit) return '';

  // 2. 判性
  let type = '';
  if (CRITICISM.test(text)) type = 'criticism';
  else if (PRAISE.test(text)) type = 'praise';
  else if (INCIDENT.test(text)) type = 'incident';
  if (!type) return '';

  const ev = {
    at: Date.now(),
    type,
    from: { uid: String(msg.userId || ''), nick: String(msg.name || '') },
    myWords: String(hit.text || '').slice(0, 80),
    theirWords: text.slice(0, 120),
    where: String(msg.key || ''),
  };
  events.push(ev);
  if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);

  try { fs.appendFileSync(path.join(dir, 'growth.jsonl'), JSON.stringify(ev) + '\n', 'utf8'); } catch {}

  selfImage.counts[type] = (selfImage.counts[type] || 0) + 1;
  selfImage.updatedAt = Date.now();
  saveSelfImage();

  console.log(`[Growth] ${type === 'praise' ? '被夸' : type === 'criticism' ? '被嫌' : '被问身份'} ← ${ev.from.nick}：${ev.theirWords.slice(0, 40)}`);

  // 3. 批评攒够就归纳成行为约束（异步，不阻塞对话）
  if (type === 'criticism') {
    pendingCriticism.push(ev);
    if (pendingCriticism.length >= DISTILL_EVERY && !distilling) {
      setTimeout(() => { distill().catch(() => {}); }, 200);
    }
  }

  return type;
}

/** 让模型把批评归纳成"以后别做X" */
async function distill() {
  if (!brainRef || typeof brainRef.complete !== 'function') return;
  if (distilling || !pendingCriticism.length) return;
  distilling = true;

  const batch = pendingCriticism.slice(-8);
  const list = batch.map((e, i) => `${i + 1}. ${e.from.nick}：${e.theirWords}（你当时说：${e.myWords || '（没记下）'}）`).join('\n');

  const prompt = `你在群里被人嫌了。下面是真实发生的事，提炼出你以后再遇到类似情况该怎么避免。

${list}

要求：
- 输出 1-3 条具体可执行的行为约束，写"别做什么/该怎么做"，不要写"要注意"这种废话
- 每条 20 字以内，像在提醒自己
- 只针对行为，不要写成自我贬低
- 同一类问题合并成一条

只输出 JSON：{"avoidRules":["……","……"]}`;

  try {
    const raw = await brainRef.complete({ prompt, temperature: 0.4, max_tokens: 300, json: true });
    const parsed = JSON.parse(raw || '{}');
    const rules = Array.isArray(parsed.avoidRules)
      ? parsed.avoidRules.filter((r) => typeof r === 'string' && r.trim()).slice(0, 3)
      : [];

    if (rules.length) {
      for (const r of rules) {
        const rule = r.trim().slice(0, 40);
        const old = selfImage.avoidRules.find((x) => x.rule === rule);
        if (old) { old.hits = (old.hits || 1) + 1; old.at = Date.now(); }
        else selfImage.avoidRules.push({ rule, hits: 1, at: Date.now() });
      }
      // 权重高的留下，最多 8 条
      selfImage.avoidRules = selfImage.avoidRules
        .sort((a, b) => (b.hits || 1) - (a.hits || 1) || (b.at || 0) - (a.at || 0))
        .slice(0, MAX_RULES);
      selfImage.updatedAt = Date.now();
      saveSelfImage();
      console.log(`[Growth] 归纳出 ${rules.length} 条：${rules.join(' / ')}`);
      pendingCriticism = [];
    }
  } catch (e) {
    console.error('[Growth] 归纳失败：' + (e?.message || e));
  } finally {
    distilling = false;
  }
}

function saveSelfImage() {
  try {
    const { avoidRules, counts, traits, updatedAt } = selfImage;
    fs.writeFileSync(path.join(dir, 'self-image.json'), JSON.stringify({ avoidRules, counts, traits, updatedAt }, null, 2), 'utf8');
  } catch {}
}

/** 给 system prompt 用：该避免什么 + 最近被怎么对待 */
export function renderGrowth() {
  if (!enabled) return '';
  const parts = [];

  if (selfImage.avoidRules?.length) {
    const lines = selfImage.avoidRules.slice(0, 5).map((r) => {
      const n = r.hits > 1 ? `（被说过 ${r.hits} 次）` : '';
      return `- ${r.rule}${n}`;
    });
    parts.push(`【你以前招过人烦，这些别再犯】\n${lines.join('\n')}`);
  }

  const recent = [];
  const seen = new Set();
  for (let i = events.length - 1; i >= 0 && recent.length < 4; i--) {
    const e = events[i];
    const k = `${e.type}|${e.theirWords}`;
    if (seen.has(k)) continue;
    seen.add(k);
    recent.unshift(e);
  }
  if (recent.length) {
    const lines = recent.map((e) => {
      const who = e.from?.nick || '有人';
      const said = e.theirWords.slice(0, 40);
      if (e.type === 'praise') return `- ${who} 夸过你：${said}`;
      if (e.type === 'criticism') return `- ${who} 嫌过你：${said}`;
      return `- ${who} 问过你：${said}`;
    });
    parts.push(`【最近群里对你的反应（别复述原话）】\n${lines.join('\n')}`);
  }

  return parts.length ? '\n' + parts.join('\n') : '';
}

/** 给页面/调试用 */
export function getGrowthSummary() {
  return { counts: selfImage.counts, avoidRules: selfImage.avoidRules, recent: events.slice(-10) };
}
