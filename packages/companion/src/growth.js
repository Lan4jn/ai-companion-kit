/**
 * 成长记忆 —— 从群聊里针对她的批评、表扬、特殊事件里，长出"对自己的认知"。
 *
 * 跟 chatter-learner 的分工：
 *   chatter-learner  学「别人怎么说话」，产出发言风格
 *   growth           学「别人怎么对她」，产出自我认知（哪里讨人嫌、哪里被喜欢）
 *
 * 只存结论和原话片段，不存整段聊天。落盘两个文件：
 *   data/growth.jsonl     每条事件一行
 *   data/self-image.json  汇总出来的自我认知
 */

import fs from 'node:fs';
import path from 'node:path';

// 群友在夸她
const PRAISE = /(厉害|牛啊|牛哇|牛逼|666|太强|真会|说得好|说得对|笑死|哈哈{2,}|可爱|懂事|聪明|有道理|服了|学到了|宝藏|真棒|好玩|有意思|绝了|真行|可以啊)/;
// 群友在嫌她
const CRITICISM = /(闭嘴|滚吧|滚蛋|滚开|烦死|真烦|有点烦|傻子|太傻|真傻|蠢死|别说了|什么鬼|你懂个屁|胡说|扯淡|离谱|没用的东西|别乱说|住嘴|够了|说话太冲|太凶了|别阴阳|别装|少来|答非所问|没听懂|说人话|别岔开|又跑题|听不懂人话)/;
// 特殊事件：问她身份、考她、让她干活
const INCIDENT = /(你是谁|你主人|你爸|谁做的|什么模型|你是\s*ai|测试|考你|你会什么|你能干嘛|谁的小鱼|你几岁|你哪来的)/;

const MAX_OWN = 300;        // 记住最近 300 条自己说的话，用于匹配回应
const MAX_EVENTS = 800;     // growth.jsonl 最多留这么多行

let dir = '';
let ownMessages = [];       // { messageId, chatKey, text, at, replyToUid }
let events = [];            // 内存里的近期事件
let selfImage = { counts: { praise: 0, criticism: 0, incident: 0 }, traits: [], updatedAt: 0 };
let enabled = true;

export function initGrowth({ dataDir, cfg } = {}) {
  dir = dataDir || path.join(process.cwd(), 'data');
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
    if (fs.existsSync(f)) selfImage = { ...selfImage, ...JSON.parse(fs.readFileSync(f, 'utf8')) };
  } catch {}

  console.log(`[Growth] 成长记忆已加载：${events.length} 条事件，认知 ${selfImage.traits?.length || 0} 条`);
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
  if (msg.replyTo) {
    hit = ownMessages.find((m) => m.messageId === String(msg.replyTo));
  }
  if (!hit && selfId) {
    const raw = JSON.stringify(msg.raw || []);
    if (raw.includes(`qq=${selfId}`) || raw.includes(`"qq":"${selfId}"`)) hit = { text: '' };
  }
  if (!hit && /(小鱼|小肥鱼|鱼形RBQ)/.test(text)) hit = { text: '' };
  if (!hit) return;

  // 2. 判性
  let type = '';
  if (CRITICISM.test(text)) type = 'criticism';
  else if (PRAISE.test(text)) type = 'praise';
  else if (INCIDENT.test(text)) type = 'incident';
  if (!type) return;

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

  try {
    fs.appendFileSync(path.join(dir, 'growth.jsonl'), JSON.stringify(ev) + '\n', 'utf8');
  } catch {}

  // 3. 更新自我认知
  selfImage.counts[type] = (selfImage.counts[type] || 0) + 1;
  selfImage.updatedAt = Date.now();
  rebuildTraits();
  try {
    fs.writeFileSync(path.join(dir, 'self-image.json'), JSON.stringify(selfImage, null, 2), 'utf8');
  } catch {}

  console.log(`[Growth] ${type === 'praise' ? '被夸' : type === 'criticism' ? '被嫌' : '被问身份'} ← ${ev.from.nick}：${ev.theirWords.slice(0, 40)}`);
}

/** 把事件归纳成几条能带进 prompt 的自我认知 */
function rebuildTraits() {
  const since = Date.now() - 30 * 24 * 3600 * 1000;
  const recent = events.filter((e) => e.at >= since);
  const traits = [];

  const crit = recent.filter((e) => e.type === 'criticism').slice(-6);
  const praise = recent.filter((e) => e.type === 'praise').slice(-6);

  if (crit.length) {
    traits.push('被人嫌过的地方（原话）：' + crit.map((e) => `“${e.theirWords.slice(0, 28)}”`).join('、'));
  }
  if (praise.length) {
    traits.push('被人夸过的地方（原话）：' + praise.map((e) => `“${e.theirWords.slice(0, 28)}”`).join('、'));
  }
  const c = selfImage.counts;
  if ((c.criticism || 0) + (c.praise || 0) >= 6) {
    const ratio = c.criticism / Math.max(1, c.criticism + c.praise);
    if (ratio > 0.6) traits.push('最近被你呛到的人不少，说话前先想一想对方是不是只是随口一说。');
    else if (ratio < 0.25) traits.push('最近大家挺吃你这套，保持就好，别刻意讨好。');
  }
  selfImage.traits = traits;
}

/** 给 system prompt 用：最近被怎么对待过 */
export function renderGrowth() {
  if (!enabled) return '';
  const recent = events.slice(-6);
  if (!recent.length) return '';
  const lines = recent.map((e) => {
    const who = e.from?.nick || '有人';
    if (e.type === 'praise') return `- ${who} 夸过你：${e.theirWords}`;
    if (e.type === 'criticism') return `- ${who} 嫌过你：${e.theirWords}`;
    return `- ${who} 问过你：${e.theirWords}`;
  });
  return `\n【你最近在群里被怎么对待过（真实发生的事，别复述原话，只当成对自己的印象）】\n${lines.join('\n')}`;
}

/** 给页面/调试用 */
export function getGrowthSummary() {
  return { counts: selfImage.counts, traits: selfImage.traits, recent: events.slice(-10) };
}
