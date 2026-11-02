/**
 * 关系账本 · 她跟每个人处到哪一步了
 * ─────────────────────────────────────────────────────────────
 * 真人不会对所有人都一个态度。同一个人，昨天夸过她、今天骂了她，
 * 她心里是有账的，表现出来就是——心情好就多说两句，被骂了会冷下来，
 * 骂得太狠干脆不理。
 *
 * 只认"直接指向她"的信号：夸她、骂她、谢她。
 * 群友之间互相掐架不算，那跟她的关系无关。
 *
 * 两个维度：
 *   intimacy  亲密度 -100 ~ 100   决定"愿不愿意理你"
 *   trust     信任     0 ~ 100    决定"愿不愿意跟你说实话"
 *
 * 都会随时间自然回落（半衰期 30 天）。人不联系就会淡，这是对的。
 */

import fs from 'node:fs';
import path from 'node:path';

const INSULT = /滚|傻逼|傻鸟|闭嘴|烦死|恶心|去死|神经病|有病吧|别烦我|垃圾|废物|你算什么东西|蠢|弱智|脑残/i;
const PRAISE = /可爱|好看|厉害|牛逼|牛啊|真棒|喜欢你|不错啊|有意思|好听|温柔|靠谱/i;
const THANKS = /谢谢|多谢|感谢|谢了|辛苦了/i;

const HALF_LIFE_DAYS = 30;
const DAY = 86400e3;

/** 亲密度决定称呼 */
function tierOf(intimacy) {
  if (intimacy <= -40) return '结过梁子的人';
  if (intimacy <= -10) return '有点看不顺眼的人';
  if (intimacy < 20) return '眼熟的群友';
  if (intimacy < 60) return '常聊的熟人';
  return '铁瓷';
}

export class Relationship {
  /**
   * @param {object} opts
   * @param {string} [opts.dir]        数据目录
   * @param {boolean} [opts.enabled=true]
   */
  constructor({ dir = './data', enabled = true } = {}) {
    this.enabled = enabled;
    this.file = path.join(dir, 'relationships.json');
    /** @type {Record<string, any>} */
    this.book = {};
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.file)) {
        this.book = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {};
      }
    } catch {
      this.book = {};
    }
    this._decayAll();
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.book, null, 2), 'utf8');
    } catch { /* 写不进去就算了，别影响聊天 */ }
  }

  /** 长期不联系，关系自然变淡（指数衰减，半衰期 30 天） */
  _decayAll() {
    const now = Date.now();
    let dirty = false;
    for (const rec of Object.values(this.book)) {
      if (!rec || !rec.lastSeen) continue;
      const days = (now - rec.lastSeen) / DAY;
      if (days < 1) continue;
      const k = Math.pow(0.5, days / HALF_LIFE_DAYS);
      rec.intimacy = rec.intimacy * k;
      rec.trust = 50 + (rec.trust - 50) * k;   // 信任向 50 回归，不会归零
      dirty = true;
    }
    if (dirty) this._save();
  }

  _rec(userId) {
    const id = String(userId);
    if (!this.book[id]) {
      this.book[id] = { intimacy: 0, trust: 50, lastSeen: Date.now(), lastInsult: 0, insults: 0, praises: 0 };
    }
    return this.book[id];
  }

  /**
   * 吃进一条消息，更新账本。
   * @returns {{delta:number, kind:string}}
   */
  observe(userId, text, { isOwner = false } = {}) {
    if (!this.enabled) return { delta: 0, kind: 'none' };
    const t = String(text || '');
    const rec = this._rec(userId);
    rec.lastSeen = Date.now();

    let delta = 0;
    let kind = 'none';

    if (INSULT.test(t)) {
      // 骂得越狠掉得越多，但同一个人短时间内连骂不会无限叠加
      const recent = Date.now() - (rec.lastInsult || 0) < 10 * 60e3;
      delta = recent ? -3 : -12;
      rec.lastInsult = Date.now();
      rec.insults = (rec.insults || 0) + 1;
      kind = 'insult';
    } else if (PRAISE.test(t)) {
      delta = isOwner ? 4 : 6;
      rec.praises = (rec.praises || 0) + 1;
      kind = 'praise';
    } else if (THANKS.test(t)) {
      delta = 2;
      kind = 'thanks';
    } else {
      // 正常唠两句，慢慢升温，但有天花板
      rec.intimacy = Math.min(80, rec.intimacy + 0.4);
      rec.trust = Math.min(95, rec.trust + 0.2);
      this._save();
      return { delta: 0.4, kind: 'talk' };
    }

    rec.intimacy = Math.max(-100, Math.min(100, rec.intimacy + delta));
    rec.trust = Math.max(0, Math.min(100, rec.trust + (kind === 'insult' ? -8 : 3)));
    this._save();
    return { delta, kind };
  }

  /** 给提示词用的一行 */
  render(userId) {
    if (!this.enabled) return '';
    const rec = this.book[String(userId)];
    if (!rec) return '';
    const tier = tierOf(rec.intimacy);
    return `【你和他现在的关系】${tier}（亲密度 ${rec.intimacy.toFixed(0)}/100，信任 ${rec.trust.toFixed(0)}/100）`;
  }

  /**
   * 该不该理他。
   *
   * - ignore：结过梁子、刚被骂完 —— 直接不回（老爸除外）
   * - cold  ：不太待见 —— 回，但很简短、不带热乎气
   * - normal：正常
   */
  verdict(userId, { isOwner = false } = {}) {
    if (!this.enabled || isOwner) return 'normal';
    const rec = this.book[String(userId)];
    if (!rec) return 'normal';
    const justInsulted = Date.now() - (rec.lastInsult || 0) < 30 * 60e3;
    if (rec.intimacy <= -40 && justInsulted) return 'ignore';
    if (rec.intimacy <= -10) return 'cold';
    return 'normal';
  }

  /** 被冷落时的行为约束，塞进 situation */
  styleHint(verdict) {
    if (verdict === 'cold') return '【你对这个人不太待见】回他就一两个字，或者嗯、哦、随便，不要热情，不要主动找话。';
    return '';
  }
}

export default Relationship;
