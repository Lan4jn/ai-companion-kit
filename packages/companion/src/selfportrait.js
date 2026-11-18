/**
 * 自我形象：让她真的"看见"自己。
 *
 * 两种用法：
 * 1. 自述——把她自己的立绘交给视觉模型看一遍，生成一段第三人称的客观描述，
 *    落到 data/self-portrait.txt，再由 role.js 拼进 system prompt。
 *    这样她对"我长什么样"的认识不是人手写的转述，而是从图上直接看来的。
 * 2. 发图——有人要照片，就从 assets/self/ 里抽一张发出去。
 *
 * 缓存策略：以目录里最新的 mtime 为版本号，图换了才会重新看图，不会每次启动都烧一次视觉。
 */

import fs from 'node:fs';
import path from 'node:path';

const IMG_RE = /\.(png|jpe?g|webp)$/i;

// 要照片的意图。要求句子指向"她本人"，避免"发张图看看这游戏"被误判。
// 三类：①问你长什么样 ②让你发照片/自拍 ③说"看看你"
const PHOTO_RE = /(你|你自己).{0,6}(照片|自拍|长啥样|长什么样|什么样子|长得)|(发|来|给|拍|有).{0,6}(张|个)?.{0,3}(照片|自拍)|(看看|看下|看一眼).{0,4}你|自拍/;

// 但指向别人的一律不接："你爸照片""我的照片""他自拍"
const NOT_ME_RE = /(我的|我妈|我爸|你爸|你妈|别人|他|她|朋友|同学|同事)的?.{0,3}(照片|自拍)/;

const PROMPT = [
  '这是一张角色立绘。请客观描述这个角色：发色发型、眼睛、头顶和耳侧的特殊部件、',
  '服装的每一层、鞋子、身后的尾巴、整体配色。',
  '只描述画面上确实存在的东西，不要推测性格，不要加评论。250 字以内，用陈述句。',
].join('');

export class SelfPortrait {
  constructor({ dir, cachePath, brain, log = console.log }) {
    this.dir = dir;
    this.cachePath = cachePath;
    this.brain = brain;
    this.log = log;
    this.desc = '';
    this._sent = new Map();   // key -> 上次发图时间
    this.cooldownMs = 30 * 60e3;
  }

  images() {
    try {
      return fs.readdirSync(this.dir)
        .filter((f) => IMG_RE.test(f))
        .map((f) => path.join(this.dir, f));
    } catch {
      return [];
    }
  }

  /** 图的版本号：最新 mtime */
  _version() {
    let v = 0;
    for (const p of this.images()) {
      try { v = Math.max(v, fs.statSync(p).mtimeMs); } catch {}
    }
    return v;
  }

  loadCache() {
    try {
      const d = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
      if (Number(d.version) === this._version() && d.desc) this.desc = d.desc;
    } catch {}
    return this.desc;
  }

  /** 看图并缓存。已经有同版本的描述就直接返回，不重复烧视觉。 */
  async ensure() {
    this.loadCache();
    if (this.desc) {
      const txt = this.cachePath.replace(/\.json$/, '.txt');
      try { if (!fs.existsSync(txt)) fs.writeFileSync(txt, this.desc, 'utf8'); } catch {}
      return this.desc;
    }

    const imgs = this.images();
    if (!imgs.length) return '';

    try {
      const buf = fs.readFileSync(imgs[0]);
      const mime = imgs[0].toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
      const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
      const text = await this.brain.describeImage(dataUrl, { shrink: true });
      if (!text || text.length < 20) {
        this.log('   [selfportrait] 视觉没给出有效描述，跳过');
        return '';
      }
      this.desc = text.trim();
      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
      fs.writeFileSync(
        this.cachePath,
        JSON.stringify({ version: this._version(), desc: this.desc, at: Date.now() }, null, 2),
        'utf8',
      );
      // 再写一份纯文本，role.js 直接读，不用解 JSON
      fs.writeFileSync(this.cachePath.replace(/\.json$/, '.txt'), this.desc, 'utf8');
      this.log(`   [selfportrait] 已生成自述（${this.desc.length} 字）`);
    } catch (e) {
      this.log(`   [selfportrait] 看图失败: ${e.message}`);
    }
    return this.desc;
  }

  wantsPhoto(text) {
    if (!text) return false;
    const t = String(text);
    // 说"我的照片""你爸照片"就不接
    if (NOT_ME_RE.test(t)) return false;
    if (PHOTO_RE.test(t)) return true;
    // 去掉所有感叹号、问号、标点和空格后做一次宽松意图匹配（如“快！点！拍！”、“照！！片！！！”、“拍！照！”）
    const clean = t.replace(/[！!？?~～\s，。、·\-_]/g, '');
    if (PHOTO_RE.test(clean)) return true;
    return /(快点拍|快拍|照片|自拍|来张照|拍个照|自拍照|拍给我看|现拍一张)/.test(clean);
  }

  canSend(key) {
    if (!this.images().length) return false;
    const last = this._sent.get(key) || 0;
    // 私聊老爸降低冷却到 1 分钟，群聊保持默认冷却
    const cd = (typeof key === 'string' && key.startsWith('private:')) ? 60e3 : this.cooldownMs;
    return Date.now() - last > cd;
  }

  pick(contextText = '', lastPath = '') {
    const imgs = this.images();
    if (!imgs.length) return null;
    if (imgs.length === 1) return imgs[0];

    // 语境倾向
    const t = String(contextText || '');
    if (/洗脸|洗完脸|洗过脸|素颜|水润|湿/.test(t)) {
      const match = imgs.find(f => f.includes('washface'));
      if (match) return match;
    }
    if (/阳台|天气|阴天|刮风|外面|冷|凉/.test(t)) {
      const match = imgs.find(f => f.includes('balcony'));
      if (match) return match;
    }
    if (/生气|气鼓鼓|噘嘴|笨鱼|气人|不理你|嘟嘴/.test(t)) {
      const pouts = imgs.filter(f => f.includes('pout'));
      if (pouts.length) return pouts[Math.floor(Math.random() * pouts.length)];
    }
    if (/阳台|天气|阳光|晴天|早安|晨光|微风|外面/.test(t)) {
      const match = imgs.find(f => f.includes('sunshine')) || imgs.find(f => f.includes('balcony'));
      if (match) return match;
    }
    if (/发呆|无聊|榻榻米|房间|喝茶|坐着|居家|休闲/.test(t)) {
      const match = imgs.find(f => f.includes('tatami'));
      if (match) return match;
    }
    if (/奶茶|咖啡|喝水|杯子|店|出去玩|逛街/.test(t)) {
      const match = imgs.find(f => f.includes('cafe'));
      if (match) return match;
    }
    if (/书桌|桌子|趴着|学习|写字|看书/.test(t)) {
      const match = imgs.find(f => f.includes('desk'));
      if (match) return match;
    }
    if (/沙发|抱枕|玩偶|抱抱|窝着/.test(t)) {
      const match = imgs.find(f => f.includes('sofa'));
      if (match) return match;
    }
    if (/女仆|漂亮|好看|正经|打扮|出门|自拍|可爱|新衣服/.test(t)) {
      const match = imgs.find(f => f.includes('maid-selfie'));
      if (match) return match;
    }

    // 排除上一次发过的那张，避免连发两张完全一样的图
    const candidates = lastPath ? imgs.filter(f => f !== lastPath) : imgs;
    const pool = candidates.length > 0 ? candidates : imgs;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  markSent(key) {
    this._sent.set(key, Date.now());
  }
}
