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

const ALL_TOOLS = [...PHONE_TOOLS, ...LEGAL_TOOLS, ...SEARCH_TOOLS];

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
  constructor({ apiKey, baseUrl = 'https://api.deepseek.com/v1', model = 'deepseek-chat', timeoutMs = 120000, role, memory, vision = null, visionFallback = null, videoVision = null,
    recall = null, dataDir = './data' }) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.vision = vision && vision.apiKey && vision.baseUrl && vision.model ? vision : null;
    this.visionFallback = visionFallback && visionFallback.apiKey && visionFallback.baseUrl && visionFallback.model ? visionFallback : null;
    this.videoVision = videoVision && videoVision.apiKey && videoVision.baseUrl && videoVision.model ? videoVision : null;
    this.recall = typeof recall === 'function' ? recall : null;
    this.role = role || new Role({ cardPath: 'role.md' });
    this.memory = memory || new Memory({ dir: './data' });
    this.dataDir = dataDir;
  }

  /**
   * 用独立的视觉模型把图片描述成文字。
   * 主模型（deepseek）本身不支持图像输入，直接塞 image_url 会被忽略，
   * 所以这里先过一道视觉模型，把画面转成文本再交给主模型。
   *
   * 会按 vision → visionFallback 的顺序重试；全部失败才返回 null。
   * 每一步失败都记日志，不然静默 null 会让上层以为"读到了但没内容"。
   */
  async describeImage(dataUrl, { timeoutMs = 25000, prefer = null, shrink = true } = {}) {
    if (!dataUrl) return null;

    const chain = prefer === 'videoVision' && this.videoVision
      ? [this.videoVision, this.vision, this.visionFallback]
      : [this.vision, this.visionFallback];

    const providers = chain.filter((p, i, arr) => p && arr.indexOf(p) === i);
    if (providers.length === 0) return null;

    // 九宫格这类需要保留细节的图不能压到 768，否则每格只剩两百多像素，字全糊
    const small = shrink ? await shrinkDataUrl(dataUrl) : dataUrl;

    for (const v of providers) {
      const text = await this._visionCall(v, small, timeoutMs);
      if (text) return text;
    }
    console.log('[vision] 所有视觉模型都失败，这张图按"读不出来"处理');
    return null;
  }

  /** 单次视觉请求；失败返回 null 并打印原因 */
  async _visionCall(v, small, timeoutMs) {
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
                text: '用中文提炼这张图片的核心信息。严格禁止描述图片的几何形状、长宽比或构图（绝对不要出现“长方形”、“长条”、“方形”、“竖版”、“这是一张图片”等字眼）。如果是截图或聊天记录，重点直接提取里面的关键文字内容和关键数字（谁说的、说了什么、关键弹窗）；如果是照片，说清场景、人物和正在做的事。不要客套，不要评论。',
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
      const c = msg.content;
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

  async reply(input) {
    const { key, userId, userName, text, images = [], stickers = 0, stickerImages = [], situation = '', history = [], record = true } = input;

    const memLine = this.memory.renderPerson(userId);
    const diary = this.memory.renderDiary ? this.memory.renderDiary(6) : '';
    const recent = this.memory.renderRecent(20, { excludeWhere: key });
    let learnedLine = '';
    if (this.recall) {
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
    if (this.memory && typeof this.memory.recallTurns === 'function') {
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
        nowLine = `现在是真实现实时间 ${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日${period} ${hm}。${dynamicPart}（注意：真实自然说话，绝对禁止把“刚醒/刚睡醒/睡到现在”当成口癖或借口反复说；可以在内心草稿箱（（心情: 状态，原因: xxx））里自然写下你听完对方的话、或者说完这句之后的心情变化）。\n`;
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
    if (Array.isArray(images) && images.length > 0) {
      // 多张图并行处理，避免一张一张串行等待
      const dataUrls = (await Promise.all(images.map((img) => toDataUrl(img)))).filter(Boolean);
      if (this.vision) {
        const descs = (await Promise.all(dataUrls.map((d) => this.describeImage(d)))).filter(Boolean);
        if (descs.length > 0) {
          const hint = descs.map((d, i) => `第${i + 1}张图：${d}`).join('\n');
          userContent = `${String(text || '').trim()}\n\n【对方发了${descs.length}张图，画面核心内容已提炼如下。真人老群友看图法则：直接针对图中的文字、槽点、胜负或事情发表看法，绝对禁止报备图片的形状或说“这是一张长方形截图”等机械废话】\n${hint}`.trim();
        } else {
          userContent = `${String(text || '[图片]').trim()}\n\n（图片没加载出来，你根本没看到画面内容。禁止编造任何画面细节、禁止假装看懂了——只能老实说没看清或打不开，让对方说一句）`;
        }
      } else if (dataUrls.length > 0) {
        const parts = [{ type: 'text', text: String(text || '[图片]') }];
        for (const d of dataUrls) parts.push({ type: 'image_url', image_url: { url: d } });
        userContent = parts;
      } else {
        userContent = `${String(text || '[图片]').trim()}\n\n（图片没加载出来，你根本没看到画面内容。禁止编造任何画面细节、禁止假装看懂了——只能老实说没看清或打不开，让对方说一句）`;
      }
    }

    // 表情包不是照片：真人看到表情包不会描述画面，只会直接反应。
    // 但 QQ 标成「动画表情」(sub_type=1) 的图也可能是对方真想让你看的内容（比如一张画），
    // 所以照样过一遍视觉，只把结果当背景知识塞进去，不逼她描述画面。
    if (stickers > 0) {
      let stickerHint = '';
      if (Array.isArray(stickerImages) && stickerImages.length > 0) {
        const urls = (await Promise.all(stickerImages.map((u) => toDataUrl(u)))).filter(Boolean);
        const descs = (await Promise.all(urls.map((d) => this.describeImage(d)))).filter(Boolean);
        if (descs.length > 0) {
          stickerHint = '\n\n【对方发的表情包画面是这样的（平时别去描述它；但对方问起里面有什么，你要知道，不能编）】\n'
            + descs.map((d, i) => `第${i + 1}张：${d}`).join('\n');
        }
      }
      const base = typeof userContent === 'string' ? userContent : String(text || '');
      const tail = `（对方这次发的是 ${stickers} 个表情包，不是照片。表情包不要描述画面内容，也别来一句"这图好搞笑"式的点评——真人的反应是直接笑、接梗、骂回去、或者干脆回一个表情。）`
        + stickerHint;
      userContent = base ? `${base}\n\n${tail}` : tail;
    }
    messages.push({ role: 'user', content: userContent });

    // 第一次调用模型（仅在需要时挂载工具，B站内部与私信禁用手机工具避免误调用）
    const enableTools = input.tools !== false && !String(key || '').startsWith('__bili_');
    const reqPayload = {
      model: this.model,
      messages,
      temperature: 1.1,
      stream: false,
    };
    if (enableTools) {
      reqPayload.tools = ALL_TOOLS;
      reqPayload.tool_choice = 'auto';
    }

    const res = await fetch(this.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + this.apiKey },
      body: JSON.stringify(reqPayload),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const raw = await res.text();
    if (!res.ok) throw new Error('模型返回 ' + res.status + '：' + raw.slice(0, 300));

    let json;
    try { json = JSON.parse(raw); } catch { throw new Error('模型返回不是 JSON：' + raw.slice(0, 200)); }
    const choice = json.choices?.[0];
    let msg = choice?.message;
    let out = String(msg?.content || '').trim();
    let cqImageToSend = '';
    let voiceB64ToSend = '';

    // 如果模型决定调用手机工具
    if (msg?.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      console.log(`[工具调用] 小鱼触发了 ${msg.tool_calls.length} 个操作：` + msg.tool_calls.map(tc => `${tc.function.name}(${tc.function.arguments || ''})`).join(', '));
      messages.push(msg);

      for (const tc of msg.tool_calls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
        let execRes;
        if (tc.function.name === 'web_search') {
          execRes = await executeSearchTool(tc.function.name, args);
        } else if (tc.function.name === 'legal_lookup') {
          execRes = await executeLegalTool(tc.function.name, args);
        } else {
          execRes = await executePhoneTool(tc.function.name, args);
        }
        
        if (execRes.cq_image) {
          cqImageToSend = execRes.cq_image;
        }
        if (execRes.voice_b64) {
          voiceB64ToSend = execRes.voice_b64;
        }

        const toolMsg = {
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(execRes)
        };
        messages.push(toolMsg);

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
          const content = [{ type: 'text', text: `【这是录屏/视频抽出的 ${execRes.images_b64.length} 张连续关键画面，请观察动态过程回答】` }];
          for (const b64 of execRes.images_b64) {
            content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } });
          }
          messages.push({ role: 'user', content });
        }
      }

      const res2 = await fetch(this.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + this.apiKey },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: 1.1,
          stream: false
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const raw2 = await res2.text();
      if (res2.ok) {
        const json2 = JSON.parse(raw2);
        out = String(json2.choices?.[0]?.message?.content || '').trim();
      }
    }

    // 清洗模型思维链和系统提示词内部标签（防止推理模型将思考内容漏出到 QQ 聊天框）
    out = out.replace(/<think>[\s\S]*?<\/think>/gi, '');
    out = out.replace(/<system_reminder>[\s\S]*?<\/system_reminder>/gi, '');

    // 捕获草稿箱内容用于动态情绪状态机跃迁（在清洗前提取）
    let draftMoodText = '';
    const draftMatches = out.match(/[（(]{2}([\s\S]*?)[）)]{2}/g);
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

    if (cqImageToSend) {
      out = out ? `${out}\n${cqImageToSend}` : cqImageToSend;
    }

    // 死循环守卫：同一句反复说 / 短时间刷屏 / 连续空回复
    // 只对真正的对话生效 —— 内部判断（选不选关注、飘什么弹幕）输出本来就是
    // 结构化 JSON，重复几次是正常的，不该被当成卡住。
    if (/^(private|group):/.test(String(key || ''))) {
      const gate = loopGuard.check(key, out);
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
    }
    return { text: out, voiceB64: voiceB64ToSend, reasoning: msg?.reasoning_content, raw: json };
  }

  remember(userId, { trait, fact, topic, pending, name }) {
    return this.memory.remember(userId, { trait, fact, topic, pending, name });
  }
}

export default Brain;
