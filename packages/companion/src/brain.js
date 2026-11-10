/**
 * 大脑 · 把消息变成回复
 * ─────────────────────────────────────────────────────────────
 * 这一层做四件事：
 *   1. 组装上下文（角色卡 + 记忆 + 最近对话 + 处境）
 *   2. 挂载手机工具 (Function Calling)
 *   3. 调模型生成回复（支持多模态视觉看图，含合并转发内的图片）
 *   4. 把这一轮写回记忆
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Memory } from './memory.js';
import { Role } from './role.js';
import { getDailyMood, getSessionMood, updateSessionMood } from './mood.js';
import { PHONE_TOOLS, executePhoneTool } from './phone-tools.js';
import { loopGuard } from './loop-guard.js';
import { LEGAL_TOOLS, executeLegalTool } from './legal-tools.js';
import { SEARCH_TOOLS, executeSearchTool } from './search-tools.js';
import { TDAI_TOOLS, executeTdaiTool, syncTurnToTdai } from './tdai-tools.js';
import { cleanAllToolArtifacts, parseDsmlToolCalls } from './safety.js';

const ALL_TOOLS = [...PHONE_TOOLS, ...LEGAL_TOOLS, ...SEARCH_TOOLS, ...TDAI_TOOLS];
// 敏感/内部工具：仅限老爸本人调用，群友或陌生私聊严禁开放，杜绝隐私泄露与提权注入
const OWNER_ONLY_TOOL_NAMES = new Set([
  'phone_status', 'phone_connect', 'phone_devices', 'phone_pair',
  'phone_send_screenshot_to_chat', 'phone_get_screen', 'phone_dump', 'phone_record_screen',
  'phone_tap_text', 'phone_tap', 'phone_swipe', 'phone_drag', 'phone_type_text',
  'phone_key', 'phone_open_app', 'phone_shell', 'phone_macro',
  'phone_feed_next', 'phone_feed_prev', 'phone_like', 'phone_search',
  'send_selfie', 'read_group_chat', 'queue_group_message',
  'call_aunt', 'talk_to_hermes', 'request_feature',
  'discard_image', 'remember_person', 'tdai_search_memories',
]);
const PUBLIC_SAFE_TOOLS = ALL_TOOLS.filter((t) => !OWNER_ONLY_TOOL_NAMES.has(t?.function?.name));

async function toDataUrl(url) {
  if (!url) return null;
  if (typeof url !== 'string') return null;
  if (url.startsWith('data:')) return url;

  // 1. 本地文件路径兼容（包含 file:// 前缀与 NapCat 容器路径映射）
  let localPath = url.replace(/^file:\/\//, '');
  if (localPath.startsWith('/app/.config/QQ/')) {
    localPath = localPath.replace('/app/.config/QQ/', '/root/napcat-xiaoyu/qq/');
  }

  try {
    if (fs.existsSync(localPath) && fs.statSync(localPath).isFile()) {
      const ext = path.extname(localPath).toLowerCase().replace('.', '') || 'jpeg';
      const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
      const buf = fs.readFileSync(localPath);
      return `data:${mime};base64,${buf.toString('base64')}`;
    }
  } catch (e) {}

  // 2. HTTP/HTTPS 网络图片链接（如 QQ 官方图片 CDN）
  if (url.startsWith('http://') || url.startsWith('https://')) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
        },
        signal: AbortSignal.timeout(15000)
      });
      if (res.ok) {
        const buf = await res.arrayBuffer();
        const mime = res.headers.get('content-type') || 'image/jpeg';
        return `data:${mime};base64,${Buffer.from(buf).toString('base64')}`;
      } else {
        console.warn(`[toDataUrl] 图片下载失败 HTTP ${res.status}: ${url.slice(0, 80)}`);
      }
    } catch (e) {
      console.warn(`[toDataUrl] 图片下载异常: ${e?.message || e} (${url.slice(0, 80)})`);
    }
    return null;
  }

  return url;
}

const execFileAsync = promisify(execFile);

/**
 * 大图先压到 1280px 以内、JPEG 82。
 * 手机截图动辄 1MB+，base64 后更大，视觉模型解析会拖到十几秒；
 * 压完通常只剩一两百 KB，快很多，画面细节对"看懂内容"够用。
 */
async function shrinkDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return dataUrl;
  const m = dataUrl.match(/^data:image\/[a-z0-9.+-]+;base64,(.+)$/is);
  if (!m) return dataUrl;
  let buf;
  try {
    buf = Buffer.from(m[1], 'base64');
  } catch (e) {
    return dataUrl;
  }
  if (buf.length <= 180 * 1024) return dataUrl;

  const stem = path.join(os.tmpdir(), `xy_img_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const src = stem + '.img';
  const dst = stem + '.jpg';
  try {
    fs.writeFileSync(src, buf);
    await execFileAsync(
      'convert',
      [src, '-resize', '768x768>', '-quality', '80', '-strip', dst],
      { timeout: 15000 },
    );
    const out = fs.readFileSync(dst);
    if (out.length > 0 && out.length < buf.length) {
      return 'data:image/jpeg;base64,' + out.toString('base64');
    }
    return dataUrl;
  } catch (e) {
    return dataUrl;
  } finally {
    try { fs.unlinkSync(src); } catch (e) {}
    try { fs.unlinkSync(dst); } catch (e) {}
  }
}

export class Brain {
  constructor({ apiKey, baseUrl = 'https://api.deepseek.com/v1', model = 'deepseek-chat', timeoutMs = 120000, role, memory, vision = null, visionFallback = null, videoVision = null, mainVision = false,
    llmFallbacks = [], recall = null, dataDir = './data' }) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.llmFallbacks = Array.isArray(llmFallbacks) ? llmFallbacks : [];
    this.providerCooldowns = new Map();
    this.vision = vision && vision.apiKey && vision.baseUrl && vision.model ? vision : null;
    this.visionFallback = visionFallback && visionFallback.apiKey && visionFallback.baseUrl && visionFallback.model ? visionFallback : null;
    // 主模型自己就能看图时，别再多绕一道「图→文字→判断」，细节会在转述里丢掉
    this.mainVision = Boolean(mainVision);
    this.videoVision = videoVision && videoVision.apiKey && videoVision.baseUrl && videoVision.model ? videoVision : null;
    this.recall = typeof recall === 'function' ? recall : null;
    this.role = role || new Role({ cardPath: 'role.md' });
    this.memory = memory || new Memory({ dir: './data' });
    this.dataDir = dataDir;
  }

  isProviderCooling(name) {
    if (!name) return false;
    const until = this.providerCooldowns.get(name);
    if (!until) return false;
    if (Date.now() < until) return true;
    this.providerCooldowns.delete(name);
    return false;
  }

  setProviderCooldown(name, ms = 60000) {
    if (!name) return;
    this.providerCooldowns.set(name, Date.now() + ms);
    console.warn(`[Brain] 通道 [${name}] 触发熔断冷却，暂停使用 ${(ms / 1000).toFixed(0)} 秒`);
  }

  /**
   * 用独立的视觉模型把图片描述成文字。
   * 主模型（deepseek）本身不支持图像输入，直接塞 image_url 会被忽略，
   * 所以这里先过一道视觉模型，把画面转成文本再交给主模型。
   *
   * 会按 vision → visionFallback 的顺序重试；全部失败才返回 null。
   * 每一步失败都记日志，不然静默 null 会让上层以为"读到了但没内容"。
   */
  async describeImage(dataUrl, { timeoutMs = 25000, prefer = null, shrink = true, isSticker = false } = {}) {
    if (!dataUrl) return null;

    const chain = prefer === 'videoVision' && this.videoVision
      ? [this.videoVision, this.vision, this.visionFallback]
      : [this.vision, this.visionFallback];

    const providers = chain.filter((p, i, arr) => p && arr.indexOf(p) === i);
    if (providers.length === 0) return null;

    // 九宫格这类需要保留细节的图不能压到 768，否则每格只剩两百多像素，字全糊
    const small = shrink ? await shrinkDataUrl(dataUrl) : dataUrl;

    for (const v of providers) {
      const text = await this._visionCall(v, small, timeoutMs, { isSticker });
      if (text) return text;
    }
    console.log('[vision] 所有视觉模型都失败，这张图按"读不出来"处理');
    return null;
  }

  /** 单次视觉请求；失败返回 null 并打印原因 */
  async _visionCall(v, small, timeoutMs, { isSticker = false } = {}) {
    const base = String(v.baseUrl).replace(/\/+$/, '');
    try {
      const headers = {
        'content-type': 'application/json',
        authorization: 'Bearer ' + v.apiKey,
      };
      // opencode 的网关要求带会话头，否则直接 400 MissingSessionID
      if (base.includes('opencode.ai')) {
        headers['x-opencode-session'] = 'xiaoyu-vision-' + Date.now();
      }
      if (v.headers && typeof v.headers === 'object') {
        for (const [hk, hv] of Object.entries(v.headers)) headers[hk] = String(hv);
      }

      const promptText = isSticker
        ? '用中文提炼这张表情包/梗图的核心含义。绝对不要描述图片的边框或几何形状。请直接提炼三要素：1. 【图内配字】（无文字填“无”）；2. 【画面神态/角色】（如：柴犬斜眼笑、小猫委屈眼眶含泪、熊猫头蔑视等，10字内）；3. 【表达意图/潜台词】（对方发这张表情包想表达的态度或情绪，如：无语鄙视、挑衅反问、撒娇求关注、冷嘲热讽、爆笑认同等，10字内）。输出格式示例：【文字：“xxx” | 画面：柴犬斜眼笑 | 意图：挑衅看戏】。'
        : '用中文提炼这张图片的核心信息。严格禁止描述图片的几何形状、长宽比或构图（绝对不要出现“长方形”、“长条”、“方形”、“竖版”、“这是一张图片”等字眼）。如果是截图或聊天记录，重点直接提取里面的关键文字内容和关键数字（谁说的、说了什么、关键弹窗）；如果是照片，说清场景、人物和正在做的事；如果是表情包/梗图，提取文字与意图。不要客套，不要评论。';

      const res = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: v.model,
          // 推理模型（deepseek-v4.1-flash）会先花几百 token 思考，给太少正文就是空的
          max_tokens: 4000,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'text',
                text: promptText,
              },
              { type: 'image_url', image_url: { url: small } },
            ],
          }],
        }),
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, timeoutMs)),
      });
      if (!res.ok) {
        console.log(`[vision] ${v.model} HTTP ${res.status}`);
        return null;
      }
      const body = await res.json();
      const msg = body?.choices?.[0]?.message || {};
      const c = msg.content || msg.reasoning_content;
      if (typeof c === 'string' && c.trim()) return c.trim();
      if (Array.isArray(c)) {
        const joined = c.map((p) => (typeof p === 'string' ? p : p?.text || '')).join(' ').trim();
        if (joined) return joined;
      }
      // 推理模型把 token 全烧在 reasoning 里时 content 会是空的
      const finish = body?.choices?.[0]?.finish_reason;
      console.log(`[vision] ${v.model} 返回空正文 (finish=${finish}, reasoning=${(msg.reasoning_content || '').length} 字)`);
      return null;
    } catch (e) {
      console.log(`[vision] ${v.model} 请求异常: ${e?.name || e}`);
      return null;
    }
  }

  /**
   * 用原生支持视频的模型（gemini）直接看一段视频。
   * 和 describeImage 不同，这里不抽帧——把视频压缩后整段送进去，
   * 模型能理解动作和时间上的变化，抽帧做不到这一点。
   */
  async describeVideo(videoPath, { prompt = '', maxSeconds = 30 } = {}) {
    const vv = this.videoVision;
    if (!vv || !videoPath) return null;
    const base = String(vv.baseUrl).replace(/\/+$/, '');
    const stem = path.join(os.tmpdir(), `xy_vid_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
    const src = stem + '.src';
    const dst = stem + '.mp4';
    try {
      let buf = null;
      if (typeof videoPath === 'string' && videoPath.startsWith('data:video/')) {
        const m = videoPath.match(/^data:video\/[a-z0-9.+-]+;base64,(.+)$/is);
        if (!m) return null;
        buf = Buffer.from(m[1], 'base64');
        fs.writeFileSync(src, buf);
      } else if (fs.existsSync(videoPath)) {
        fs.copyFileSync(videoPath, src);
      } else {
        return null;
      }

      // 手机录屏动辄几 MB，压到 480 宽 / 8fps 后通常 1MB 以内，模型那边也快
      try {
        await execFileAsync(
          'ffmpeg',
          ['-y', '-hide_banner', '-loglevel', 'error', '-i', src, '-t', String(maxSeconds),
            '-vf', 'scale=480:-2', '-r', '8', '-b:v', '400k', '-an', dst],
          { timeout: 90000 },
        );
        if (fs.existsSync(dst) && fs.statSync(dst).size > 0) buf = fs.readFileSync(dst);
      } catch (e) {
        // 压缩失败就用原始数据（可能本来就是小文件）
      }
      if (!buf || buf.length > 12 * 1024 * 1024) return null;

      const headers = { 'content-type': 'application/json', authorization: 'Bearer ' + vv.apiKey };
      if (base.includes('opencode.ai')) headers['x-opencode-session'] = 'xiaoyu-video-' + Date.now();
      if (vv.headers && typeof vv.headers === 'object') {
        for (const [hk, hv] of Object.entries(vv.headers)) headers[hk] = String(hv);
      }

      const res = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: vv.model,
          max_tokens: 500,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'text',
                text: prompt || '用中文描述这段视频：画面里发生了什么、主体是什么、动作或变化的过程。如果有文字、台词、界面元素，读出来。不要客套，只描述看到的内容。',
              },
              { type: 'video_url', video_url: { url: 'data:video/mp4;base64,' + buf.toString('base64') } },
            ],
          }],
        }),
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 60000)),
      });
      if (!res.ok) return null;
      const body = await res.json();
      const c = body?.choices?.[0]?.message?.content;
      if (typeof c === 'string') return c.trim() || null;
      if (Array.isArray(c)) {
        const joined = c.map((p) => (typeof p === 'string' ? p : p?.text || '')).join(' ').trim();
        return joined || null;
      }
      return null;
    } catch (e) {
      return null;
    } finally {
      try { fs.unlinkSync(src); } catch (e) {}
      try { fs.unlinkSync(dst); } catch (e) {}
    }
  }

  /**
   * 轻量直接调用底层 LLM 进行内部反思、提炼或总结（不走角色外壳和工具系统）
   */
  async complete({ system = '', prompt, max_tokens = 1000, temperature = 0.7, json = false } = {}) {
    if (!prompt) return null;
    const messages = [];
    if (system) messages.push({ role: 'system', content: String(system) });
    messages.push({ role: 'user', content: String(prompt) });

    const payload = {
      model: this.model,
      messages,
      max_tokens,
      temperature,
      stream: false,
    };
    if (json) {
      payload.response_format = { type: 'json_object' };
    }

    try {
      const hdrs = { 'content-type': 'application/json', authorization: 'Bearer ' + this.apiKey };
      if (String(this.baseUrl).includes('opencode.ai')) {
        hdrs['x-opencode-session'] = 'xiaoyu-inner-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      }
      const res = await fetch(this.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: hdrs,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 60000)),
      });
      if (!res.ok) {
        const errText = await res.text();
        console.error(`[Brain.complete] HTTP ${res.status}: ${errText.slice(0, 150)}`);
        return null;
      }
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      return typeof content === 'string' ? content.trim() : null;
    } catch (e) {
      console.error(`[Brain.complete] 异常: ${e?.message || e}`);
      return null;
    }
  }

  async reply(input) {
    const { key, userId, userName, text, images = [], stickers = 0, stickerImages = [], situation = '', history = [], record = true, trapProbe = false } = input;
    const isOwner = String(userId || '') === '578021239';
    const isGroup = String(key || '').startsWith('group:');
    const isInternal = !String(key || '').startsWith('__bili_dm') && (
      userId === 'system' || userId === 'self' || key === '__diary_generation__' || key === '__proactive__' || String(key || '').startsWith('internal:')
    );
    const isTrusted = isOwner || isInternal;

    const memLine = this.memory.renderPerson(userId);
    const diary = (trapProbe || (!isTrusted && !isGroup)) ? '' : (this.memory.renderDiary ? this.memory.renderDiary(6) : '');
    // 非老爸或群聊场景绝不注入 private:* 私聊记忆，防止把私聊对话泄露到群里或外人私聊
    const recent = trapProbe
      ? ''
      : (isTrusted && !isGroup
          ? this.memory.renderRecent(20, { excludeWhere: key })
          : this.memory.renderRecent(10, { excludeWhere: key, excludePrivate: true }));
    let learnedLine = '';
    if (this.recall && !trapProbe) {
      try {
        const hits = this.recall(String(text || ''), 3) || [];
        if (hits.length) {
          learnedLine =
            '\n\n【你在B站看过、现在可以拿来用的东西】\n' +
            hits
              .map((h) => {
                const pts = (h.points || []).slice(0, 2).join('；');
                return `· 《${String(h.title || '').slice(0, 40)}》${pts ? '：' + pts : ''}`;
              })
              .join('\n') +
            '\n（这些是你真看过的，可以自然引用，但别硬把话题往上扯）';
        }
      } catch (e) {}
    }
    let recalledTurnsLine = '';
    if (!trapProbe && this.memory && typeof this.memory.recallTurns === 'function') {
      try {
        const hits = this.memory.recallTurns(String(text || ''), { where: key, limit: 3, excludeRecent: 80 });
        if (hits.length) {
          recalledTurnsLine =
            '\n\n【很久以前你们聊过的相关记忆（如果对方提起旧事/翻旧账，你可以自然接梗，别装傻不认账）】：\n' +
            hits.map((h) => `· ${h.who || '对方'}说：“${h.text}” → 你当时回：“${h.reply}”`).join('\n') + '\n';
        }
      } catch (e) {}
    }
    // 「当下」—— 时间 + 基础日心境与即时动态情绪。只在真实对话里加，内部判断不加。
    let nowLine = '';
    if (typeof key === 'string' && (key.startsWith('private:') || key.startsWith('group:'))) {
      try {
        const now = new Date();
        const h = now.getHours();
        const period = h < 6 ? '凌晨' : h < 12 ? '上午' : h < 14 ? '中午' : h < 18 ? '下午' : h < 23 ? '晚上' : '深夜';
        const hm = `${String(h).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        const sessionMood = getSessionMood(this.dataDir, key);
        let moodDesc = sessionMood.desc;
        if (sessionMood.key === 'sleepy') {
          if (h >= 6 && h <= 9) moodDesc = '早起有点迷糊，反应慢半拍，句子短';
          else moodDesc = '有点迷糊犯困，脑子懒得转，反应慢半拍，句子短';
        }
        const dynamicPart = sessionMood.isDynamic
          ? `【你当前的即时情绪】：${sessionMood.label}（${moodDesc}）${sessionMood.reason ? '——原因：' + sessionMood.reason : ''}。请让这个心情自然渗透在你此刻的语气、词句长短和表情包选择中（切忌机械报幕自己的心情）。\n`
          : `你今天基准心境${moodDesc}。\n`;
        nowLine = `【当前时间，凡是要说到几点、早上晚上、今天昨天，一律以这一行为准，不许自己推】现在是真实现实时间 ${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日${period} ${hm}。${dynamicPart}（注意：真实自然说话，绝对禁止把“刚醒/刚睡醒/睡到现在”当成口癖或借口反复说；可以在内心草稿箱（（心情: 状态，原因: xxx））里自然写下你听完对方的话、或者说完这句之后的心情变化）。\n`;
      } catch (e) {}
    }
    const fullSituation = nowLine + (situation ? situation + '\n\n' : '') + (diary ? diary + '\n' : '') + learnedLine + recalledTurnsLine;
    const sys = this.role.build({
      situation: fullSituation,
      memory: memLine,
      recent,
      platform: input.platform || '',
      sassy: Boolean(input.sassy),
    });

    const messages = [{ role: 'system', content: sys }];
    for (const h of history.slice(-80)) {
      if (h.isSelf) {
        messages.push({ role: 'assistant', content: String(h.text || '') });
      } else {
        if (h.text) messages.push({ role: 'user', content: `${h.who ? h.who + '：' : ''}${h.text}` });
        if (h.reply) messages.push({ role: 'assistant', content: String(h.reply) });
      }
    }

    let userContent = String(text || '');
    const allImagesToProcess = (Array.isArray(images) && images.length > 0)
      ? images
      : (Array.isArray(stickerImages) ? stickerImages : []);

    let visualAnalyzed = false;

    if (allImagesToProcess.length > 0) {
      // 多张图并行处理，避免一张一张串行等待
      const dataUrlsWithMeta = await Promise.all(
        allImagesToProcess.map(async (img) => {
          const dUrl = await toDataUrl(img);
          if (!dUrl) return null;
          const isStk = (Array.isArray(stickerImages) && stickerImages.includes(img)) || stickers > 0;
          return { dataUrl: dUrl, isSticker: isStk };
        })
      );
      const validItems = dataUrlsWithMeta.filter(Boolean);

      if (this.vision && !this.mainVision && validItems.length > 0) {
        const descs = await Promise.all(
          validItems.map((item) => this.describeImage(item.dataUrl, { isSticker: item.isSticker }))
        );
        const validDescs = descs.filter(Boolean);
        const hasSticker = validItems.some((item) => item.isSticker);

        if (validDescs.length > 0) {
          visualAnalyzed = true;
          const hint = validDescs.map((d, i) => `第${i + 1}张图：${d}`).join('\n');
          const cleanText = String(text || '')
            .replace(/^.*?（你的(?:爸爸|老爸|女儿|主人)）[：:]\s*/s, '')
            .replace(/^.*?[：:]\s*/s, '')
            .replace(/【前情提要[：:][^】]+】[^\n]*\n?/gs, '')
            .replace(/\[CQ:at,[^\]]+\]/g, '')
            .replace(/\[图片\]/g, '')
            .replace(/\[表情包?\]/g, '')
            .replace(/<faceType=[^>]+>/g, '')
            .trim();

          // 核心法则判断：只有明确对小鱼针对“图片”提问或要求评价时，才需要准确解析画面细节回答；
          // 表情包一律仅代表情绪态度，绝不视为针对画面提问！
          const isExplicitImageQuery = !hasSticker && /(这是(啥|什么|哪|哪里|谁|哪儿)|图里|图片里|这(张|个)?(图|照片|截图)(怎么样|好看吗|是啥|有什么|如何|怎么看)|评(价)?一下(这|图|它)|(看看?|查一下|查查|找找)(这|图|它)|帮我查)/i.test(cleanText);

          if (isExplicitImageQuery) {
            userContent = `${String(text || '').trim()}\n\n【明确针对图片/表情包的提问与评价】：\n- 对方正在明确针对图片内容向你提问或要求评价：“${cleanText}”\n- 视觉模型为你准确解析到的画面与细节如下：\n${hint}\n- 回复指引：请结合上述画面细节，准确回答对方针对该图片提出的问题，给出自然老群友式的回答，绝不生硬念经！`.trim();
          } else {
            // 正常聊天：表情包只是表达情绪的工具，严禁当成提问！
            const isPureSticker = !cleanText;
            userContent = `${String(text || '').trim()}\n\n【表情包/图片情绪感知】：\n${hint}\n【★核心聊天法则★】：\n1. 表情包用来表示情绪：对方并没有向你提问图片内容！表情包一般是用来表示情绪态度的（如：狂笑、嘲讽、挑衅、嫌弃、委屈、无语、卖萌、傲娇、吃瓜等各种情绪）。绝不是对方在出题考你，绝对严禁误以为对方在拿图问你，绝对严禁说“你又拿图来问我”！\n2. 正常聊天识别情绪：\n   - 如果对方带了文字：完全聚焦在对方说的文字话题上，将表情包仅视为语气和情绪氛围的补充；\n   - 如果对方单发表情包（或只带@发表情包）：看清对方表情包传达的情绪倾向，顺着这个情绪直接在上下文中回敬、反驳、接梗（例如对方发嘲笑/狂笑表情包，你顺着上一句话怼“笑屁啊”、“笑得嘴都合不拢了是吧 [表情包: 嫌弃]”、或扣个「？」），也可以甩针对性的表情包顶回去！\n3. 严禁复述与做作点评：绝对不要像识图机器一样开口描述“你发了一张黄色玩偶在笑”、“上面写着xxx”，直接按老群友直觉顺着情绪说话！`.trim();
          }
        } else {
          userContent = `${String(text || '').trim() || '？'}\n\n（注：对方发了一张图或动图表情，但视觉暂未解析。严禁像机器人一样报幕“图打不开”、“图糊了”、“没认出来”！真人不会对打不开图反复解释。如果是纯图，你可以直接扣个「？」或者甩一个疑惑/吃瓜表情包 [表情包: 问号] 顶回去；如果带了文字，就只针对对方的文字回答）`;
        }
      } else if (validItems.length > 0) {
        const parts = [{ type: 'text', text: String(text || '[图片]') }];
        for (const item of validItems) parts.push({ type: 'image_url', image_url: { url: item.dataUrl } });
        userContent = parts;
      } else {
        userContent = `${String(text || '').trim() || '？'}\n\n（注：对方发了一张图或动图表情，但视觉暂未解析。严禁像机器人一样报幕“图打不开”、“图糊了”、“没认出来”！真人不会对打不开图反复解释。如果是纯图，你可以直接扣个「？」或者甩一个疑惑/吃瓜表情包 [表情包: 问号] 顶回去；如果带了文字，就只针对对方的文字回答）`;
      }
    }

    // 表情包处理法则：仅当没有经过视觉模型解析时，才进行兜底提示
    if (stickers > 0 && !visualAnalyzed) {
      const base = typeof userContent === 'string' ? userContent : String(text || '');
      const isPureStickerAt = !text || !text.replace(/\[CQ:at,[^\]]+\]/g, '').trim();
      const tail = isPureStickerAt
        ? `（注：对方在单独/带@发纯表情包。★核心原则★：严禁复述表情包里的任何文字或画面细节！你应该判断对方发这个表情包的【意图/情绪】是什么——是在找茬、挑衅、卖萌、无语、嘲讽还是打招呼？你的回应应该是：直接甩一个针对性的表情包 [表情包: 情绪] 顶回去，或者扣个「？」/随手甩一句情绪反馈，绝不复述画面！）`
        : `（注：对方说话时附带了表情包。表情包仅仅是对方说话时调节氛围的工具！严禁复述、引用、点评或描述表情包内容！100% 只针对对方说的实际文字接茬对话，完全无视表情包的画面文字）`;
      userContent = base ? `${base}\n${tail}` : tail;
    }
    messages.push({ role: 'user', content: userContent });

    // 工具调用循环（最多支持 2 轮工具调用，支持标准 API tool_calls 与 DeepSeek DSML 格式）
    const enableTools = input.tools !== false && !String(key || '').startsWith('__bili_');
    let cqImageToSend = '';
    let voiceB64ToSend = '';
    let out = '';
    let lastMsg = null;
    let lastJson = null;
    let activeProvIdx = -1;

    for (let round = 0; round < 5; round++) {
      // 构造多层降级提供商列表：[0] 主通道 (opencode) -> ...fallbacks
      const providers = [
        { name: 'opencode-go', baseUrl: this.baseUrl, apiKey: this.apiKey, model: this.model },
        ...this.llmFallbacks
      ];

      let lastError = null;
      let successChoice = null;
      let successMsg = null;
      let successJson = null;

      // 如果上一轮已经成功确定了健康的通道，后续工具轮次优先从该通道开始，避免重蹈前面通道挂起的耗时
      const provIndices = [];
      if (round > 0 && activeProvIdx >= 0 && activeProvIdx < providers.length) {
        provIndices.push(activeProvIdx);
        for (let i = 0; i < providers.length; i++) {
          if (i !== activeProvIdx) provIndices.push(i);
        }
      } else {
        for (let i = 0; i < providers.length; i++) provIndices.push(i);
      }

      for (const pIdx of provIndices) {
        const prov = providers[pIdx];
        if (!prov.baseUrl || !prov.apiKey) continue;

        // 熔断过滤：非最后一个保底通道且在冷却期内，快速跳过，避免重复被挂起
        if (this.isProviderCooling(prov.name) && pIdx < providers.length - 1) {
          console.log(`[Brain] 通道 [${prov.name}] 仍处于熔断冷却中，快速跳过...`);
          continue;
        }

        const reqPayload = {
          model: prov.model,
          messages,
          temperature: 0.9,
          stream: false,
        };
        if (enableTools && round < 4) {
          const allowedTools = isTrusted ? ALL_TOOLS : PUBLIC_SAFE_TOOLS;
          if (allowedTools.length > 0) {
            reqPayload.tools = allowedTools;
            reqPayload.tool_choice = 'auto';
          }
        }

        const hdrs = { 'content-type': 'application/json', authorization: 'Bearer ' + prov.apiKey };
        if (String(prov.baseUrl).includes('opencode.ai')) {
          hdrs['x-opencode-session'] = 'xiaoyu-main-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
        }

        const maxAttempts = 2;
        let provSuccess = false;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          try {
            // 首试 15 秒足够，重试 22 秒
            const timeoutMs = attempt === 0 ? 15000 : 22000;
            const res = await fetch(prov.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
              method: 'POST',
              headers: hdrs,
              body: JSON.stringify(reqPayload),
              signal: AbortSignal.timeout(timeoutMs),
            });
            const raw = await res.text();
            if (!res.ok) throw new Error(`[${prov.name || prov.model}] 模型返回 ${res.status}：${raw.slice(0, 300)}`);

            let json;
            try { json = JSON.parse(raw); } catch { throw new Error(`[${prov.name || prov.model}] 模型返回不是 JSON：${raw.slice(0, 200)}`); }
            const choice = json.choices?.[0];
            const msg = choice?.message;
            if (!msg) throw new Error(`[${prov.name || prov.model}] 未返回 message`);

            successJson = json;
            successMsg = msg;
            successChoice = choice;
            lastJson = json;
            lastMsg = msg;
            lastError = null;
            provSuccess = true;
            activeProvIdx = pIdx;
            if (pIdx > 0) {
              console.log(`[Brain] 降级通道 [${prov.name || prov.model}] 成功响应`);
            }
            break;
          } catch (e) {
            lastError = e;
            const is429 = String(e.message).includes('429') || String(e.message).includes('capacity') || String(e.message).includes('overloaded');
            if (is429) {
              // 429 / overloaded 明确说明容量不足或排队，立即进入 45 秒熔断并快速降级，不长时间睡眠阻碍用户体验
              this.setProviderCooldown(prov.name, 45000);
              console.warn(`[Brain] [${prov.name || prov.model}] 上游容量不足/过载(429)，快速熔断并降级到下一通道...`);
              break;
            }
            if (attempt < maxAttempts - 1) {
              const delayMs = 1200;
              console.warn(`[Brain] [${prov.name || prov.model}] 第 ${attempt + 1} 次请求异常(${e.message})，${delayMs}ms 后重试...`);
              await new Promise(r => setTimeout(r, delayMs));
            } else {
              // 超时或其它错误达到最大重试次数，熔断冷却 60 秒
              this.setProviderCooldown(prov.name, 60000);
              console.warn(`[Brain] [${prov.name || prov.model}] 达到最大重试次数，尝试降级到下一个通道...`);
            }
          }
        }

        if (provSuccess) break;
      }

      if (!successMsg) throw lastError;

      const choice = successChoice;
      const msg = successMsg;
      let content = String(msg?.content || msg?.reasoning_content || '').trim();

      // 提取工具调用：支持标准 tool_calls 与 DeepSeek DSML 文本格式
      let toolCalls = (Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0) ? [...msg.tool_calls] : [];
      if (enableTools && toolCalls.length === 0 && content) {
        const dsmlCalls = parseDsmlToolCalls(content);
        if (dsmlCalls.length > 0) {
          toolCalls = dsmlCalls;
        }
      }

      // 如果模型触发了工具调用，且未超过轮次限制
      if (toolCalls.length > 0 && round < 4) {
        console.log(`[工具调用] 第 ${round + 1} 轮，小鱼触发了 ${toolCalls.length} 个操作：` + toolCalls.map(tc => `${tc.function.name}(${tc.function.arguments || ''})`).join(', '));
        messages.push({
          role: 'assistant',
          content: content || null,
          tool_calls: toolCalls.map((tc, idx) => ({
            id: tc.id || `call_${round}_${idx}`,
            type: 'function',
            function: tc.function
          }))
        });

        for (const tc of toolCalls) {
          let args = {};
          try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
          let execRes;
          if (!isTrusted && OWNER_ONLY_TOOL_NAMES.has(tc.function.name)) {
            console.warn(`[Security] 拦截非老爸(${userId})触发敏感工具: ${tc.function.name}`);
            execRes = { status: 'denied', message: '非老爸无权调用该内部/隐私工具，请直接用真实人类群友语气随口拒绝。' };
          } else if (tc.function.name === 'web_search') {
            execRes = await executeSearchTool(tc.function.name, args);
          } else if (tc.function.name === 'legal_lookup') {
            execRes = await executeLegalTool(tc.function.name, args);
          } else if (tc.function.name === 'tdai_search_memories') {
            execRes = await executeTdaiTool(tc.function.name, args);
          } else {
            execRes = await executePhoneTool(tc.function.name, args, { memory: this.memory, userId, userName, sessionKey: key });
          }

          if (execRes.cq_image) cqImageToSend = execRes.cq_image;
          if (execRes.voice_b64) voiceB64ToSend = execRes.voice_b64;

          messages.push({
            role: 'tool',
            tool_call_id: tc.id || `call_${round}_0`,
            content: JSON.stringify(execRes)
          });

          if (execRes.image_b64) {
            messages.push({
              role: 'user',
              content: [
                { type: 'text', text: '【这是刚刚手机屏幕截取到的最新真实画面，请观察画面回答】' },
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${execRes.image_b64}` } }
              ]
            });
          }
          if (Array.isArray(execRes.images_b64) && execRes.images_b64.length > 0) {
            const contentParts = [{ type: 'text', text: `【这是录屏/视频抽出的 ${execRes.images_b64.length} 张连续关键画面，请观察动态过程回答】` }];
            for (const b64 of execRes.images_b64) {
              contentParts.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } });
            }
            messages.push({ role: 'user', content: contentParts });
          }
        }
        continue;
      }

      // 提取最终输出内容
      out = content;
      break;
    }

    // 彻底清洗模型思维链、DSML、内部工具标签与系统提示词残留
    out = cleanAllToolArtifacts(out);

    // 捕获草稿箱内容用于动态情绪状态机跃迁（在清洗前提取）
    let draftMoodText = '';
    const draftMatches = out.match(/[（(]{2}([\\s\\S]*?)[）)]{2}/g);
    if (draftMatches) {
      draftMoodText = draftMatches.join(' ');
    }

    // 草稿箱：她可以把"想说但觉得不该说"的话写在（（…））里，这部分永远不发送。
    // 必须先于下面的括号清洗，否则会留下半截括号。
    out = out.replace(/（（[\s\S]*?））/g, '').replace(/\(\([\s\S]*?\)\)/g, '');

    // 彻底清洗掉任何动作、神态、旁白括号与星号动作描写（严禁任何（张开手）、（发表情）、（没说话）等假人味描写）
    out = out.replace(/[（(][^）)]*[）)]/g, '');
    out = out.replace(/\*[^*]+\*/g, '');
    out = out.replace(/[（）()]/g, '');
    out = out.replace(/\s{2,}/g, ' ').trim();

    // 兜底再次清除任何残留的孤立标签
    out = cleanAllToolArtifacts(out);

    if (cqImageToSend) {
      out = out ? `${out}\n${cqImageToSend}` : cqImageToSend;
    }

    // 死循环守卫：同一句反复说 / 短时间刷屏 / 连续空回复
    // 只对真正的对话生效 —— 内部判断（选不选关注、飘什么弹幕）输出本来就是
    // 结构化 JSON，重复几次是正常的，不该被当成卡住。
    if (/^(private|group):/.test(String(key || ''))) {
      const isOwner = String(userId) === '578021239';
      const hasImage = Boolean(cqImageToSend);
      const gate = loopGuard.check(key, out, { bypassFrequency: isOwner || Boolean(input.addressed) || hasImage });
      if (gate.block) {
        console.log(`[守卫] 拦下一次输出（${gate.reason}）`);
        return { text: '', blocked: true, reason: gate.reason, silent: gate.silent };
      }
    }

    // 更新会话即时情绪状态机
    if (typeof key === 'string' && (key.startsWith('private:') || key.startsWith('group:'))) {
      try {
        const isOwner = String(userId) === '578021239';
        const isGroup = key.startsWith('group:');
        updateSessionMood(this.dataDir, key, {
          draftText: draftMoodText,
          userText: text,
          replyText: out,
          isOwner,
          isGroup,
          userName,
        });
      } catch (e) {
        console.log('[mood] 更新会话情绪失败:', e?.message || e);
      }
    }

    if (record) {
      this.memory.remember(userId, { name: userName, topic: (typeof text === 'string' ? text : '').slice(0, 40) + ' → ' + out.slice(0, 40) });
      this.memory.logTurn({ where: key, who: userName || userId, text, reply: out });
      syncTurnToTdai({ where: key, who: userName || userId, text, reply: out });
    }
    return { text: out, voiceB64: voiceB64ToSend, reasoning: lastMsg?.reasoning_content, raw: lastJson };
  }

  remember(userId, { trait, fact, topic, pending, name }) {
    return this.memory.remember(userId, { trait, fact, topic, pending, name });
  }
}

export default Brain;
