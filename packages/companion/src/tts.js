// 小鱼的声音：优先使用豆包语音大模型 2.0 (seed-tts-2.0)，异常时自动回退到 edge-tts
// 输出 MP3 base64，交给 OneBot.sendVoice 发成 QQ 语音条。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';

/**
 * 用 curl 走可选代理取回二进制（fish.audio 在墙外，直连 100% 超时）。
 * 代理地址来自配置，不写死在代码里。
 */
function curlToBuffer(args, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn('curl', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error('fish.audio timeout'));
    }, timeoutMs);
    p.stdout.on('data', (c) => out.push(c));
    p.stderr.on('data', (c) => err.push(c));
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      const buf = Buffer.concat(out);
      if (code !== 0) return reject(new Error(`fish transport failure (exit ${code})`));
      if (buf.length < 512 || !(buf.subarray(0, 3).toString() === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0))) return reject(new Error('fish invalid audio'));
      resolve(buf);
    });
    p.stdin.on('error', () => {});
    p.stdin.end(input);
  });
}

/**
 * fish.audio 兜底音色（zero-shot voice clone）。
 * 跨境 + 免费档排队，正常 3~5 秒，超时给到 30 秒。
 */
// Only fixed, locally chosen tags may reach Fish as controls. Never relay mood text.
export function fishText(text, { emotion = '', intensity = '' } = {}) {
  const speech = extractEmotionAndCleanText(String(text || '')).cleanText
    .replace(/\((?:angry|annoyed|crying|sad|happy|excited|whispering|laughing|sobbing|calm|surprised|scared|disgusted|shouting|soft|gentle|neutral|furious|weeping|screaming|laugh|sigh|breathing|cough|chuckle|gasp|groan|sniffle|silence|break)[^)]*\)/gi, '')
    .replace(/\[[a-z][a-z\s,.'-]{0,80}\]/gi, '').trim();
  const e = String(emotion).trim();
  const level = ['mild', 'medium', 'strong', 'stronger'].includes(intensity) ? intensity : 'mild';
  const modifiers = { mild: 'slightly ', medium: '', strong: 'very ', stronger: 'extremely ' };
  let tag = '';
  if (/^(愤怒|生气|angry)$/.test(e)) tag = modifiers[level] + 'angry';
  else if (/^(喊叫|shout)$/.test(e)) tag = level === 'stronger' || level === 'strong' ? 'extremely angry][shouting' : modifiers[level] + 'angry';
  else if (/^(哭|cry)$/.test(e)) {
    if (level === 'medium') tag = 'sad][sobbing';
    else if (level === 'strong') tag = 'very sad][sobbing';
    else if (level === 'stronger') tag = 'extremely sad][sobbing';
    else tag = 'slightly sad][softly sobbing';
  }
  else if (/^(难过|伤心|sad)$/.test(e)) tag = modifiers[level] + 'sad';
  else if (/^(开心|高兴|happy)$/.test(e)) tag = level === 'stronger' ? 'excited][laughing' : modifiers[level] + 'happy';
  else if (/^(温柔|轻声|gentle)$/.test(e)) tag = 'with gentle warmth';
  return speech && tag ? `[${tag}] ${speech}` : speech;
}

async function synthesizeFish(text, fishCfg, timeoutMs = 30000) {
  if (!fishCfg?.apiKey || !fishCfg?.referenceId) throw new Error('fish not configured');
  const model = fishCfg.model || 's2.1-pro-free';
  const base = (fishCfg.apiBase || 'https://api.fish.audio/v1').replace(/\/+$/, '');
  const payload = JSON.stringify({
    text,
    reference_id: fishCfg.referenceId,
    format: 'mp3',
    mp3_bitrate: 128,
    model,
  });
  if (/[\r\n]/.test(fishCfg.apiKey + model)) throw new Error('invalid fish configuration');
  const quote = value => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  // curl config is delivered through stdin: neither key nor speech appears in argv.
  const config = [`header = ${quote(`Authorization: Bearer ${fishCfg.apiKey}`)}`,
    'header = "Content-Type: application/json"', `header = ${quote(`model: ${model}`)}`,
    `data-binary = ${quote(payload)}`].join('\n');
  const args = ['-sS', '--fail', '--max-time', String(Math.ceil(timeoutMs / 1000)),
    '-X', 'POST', `${base}/tts`, '--config', '-'];
  if (fishCfg.proxy) args.unshift('-x', fishCfg.proxy);
  const buf = await curlToBuffer(args, config, timeoutMs);
  return { ok: true, base64: buf.toString('base64'), bytes: buf.length, voice: `fish:${fishCfg.referenceId.slice(0, 8)}` };
}

// 豆包语音合成 2.0 (seed-tts-2.0) 音色映射
const DOUBAO_VOICES = {
  cute: 'zh_female_vv_uranus_bigtts',             // Vivi 2.0 活泼元气少女音
  gentle: 'zh_female_wenrouxiaoya_uranus_bigtts', // 温柔小雅 2.0 治愈温暖音
};

// Edge-TTS 备用音色
const EDGE_VOICES = {
  cute: 'zh-CN-XiaoyiNeural',
  gentle: 'zh-CN-XiaoxiaoNeural',
};
const EDGE_RATES = {
  cute: '+0%',
  gentle: '-8%',
};

export const TTS_STYLES = Object.keys(DOUBAO_VOICES);

// 缓存配置读取
let cachedCfg = null;
let lastCfgRead = 0;
function loadConfig() {
  const now = Date.now();
  if (cachedCfg && now - lastCfgRead < 10000) return cachedCfg;
  try {
    const p = path.resolve(process.cwd(), 'config.json');
    if (fsSync.existsSync(p)) {
      cachedCfg = JSON.parse(fsSync.readFileSync(p, 'utf-8'));
      lastCfgRead = now;
      return cachedCfg;
    }
  } catch (e) {}
  return {};
}

/**
 * 提取情绪/副语言标记并彻底清洗朗读文本
 * 火山引擎 Seed-TTS 2.0 规范：正文 text 中的方括号会被直接念出！
 * 情绪控制词必须通过 additions.context_texts 传入，text 必须保持纯净。
 */
export function extractEmotionAndCleanText(rawText) {
  let text = String(rawText || '').trim();
  const contextTexts = [];

  const tagRegex = /(?:\[([^\[\]]+)\]|\(([^\(\)]+)\)|（([^（）]+)）)/g;
  // Only unmistakable short stage directions are control tags; ordinary
  // parentheticals are part of the words the user asked to hear.
  const direction = /^(?:轻笑|嗤笑|笑|笑出声|吸鼻|吸鼻子|抽泣|哭|哽咽|叹气|无语|哼|轻哼|傲娇|打哈欠|哈欠|犯困|困|累|小声|低声|轻声|温柔|撒娇)$/;
  text = text.replace(tagRegex, (whole, square, ascii, fullwidth) => {
    const rawTag = (square || ascii || fullwidth || '').trim();
    if (!direction.test(rawTag)) return whole;
    if (rawTag.includes('吸鼻') || rawTag.includes('抽泣') || rawTag.includes('哭') || rawTag.includes('哽咽')) {
      contextTexts.push('用受委屈、抽泣、带哭腔和吸鼻子的语气说');
    } else if (rawTag.includes('轻笑') || rawTag.includes('嗤笑') || rawTag.includes('笑')) {
      contextTexts.push('用轻笑、开心的语气说');
    } else if (rawTag.includes('叹气') || rawTag.includes('无语')) {
      contextTexts.push('用叹气、无奈的语气说');
    } else if (rawTag.includes('哼') || rawTag.includes('傲娇')) {
      contextTexts.push('用傲娇、轻哼的语气说');
    } else if (rawTag.includes('打哈欠') || rawTag.includes('哈欠') || rawTag.includes('困') || rawTag.includes('累')) {
      contextTexts.push('用犯困、打哈欠的语气说');
    } else {
      contextTexts.push(`用${rawTag}的语气说`);
    }
    return '';
  });

  const cleanText = text
    .replace(/^[，。！？\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim();

  return { cleanText, contextTexts };
}

/**
 * 豆包语音合成 2.0 HTTP 单向流式合成
 */
async function synthesizeDoubao(text, style, cfg, emotion = '') {
  const apiKey = cfg?.apiKey;
  if (!apiKey) throw new Error('missing doubao apiKey');

  const speaker = cfg?.voices?.[style] || DOUBAO_VOICES[style] || DOUBAO_VOICES.cute;
  const resourceId = cfg?.resourceId || 'seed-tts-2.0';

  const { cleanText, contextTexts } = extractEmotionAndCleanText(text);
  const actualText = cleanText || text;

  if (emotion && typeof emotion === 'string') {
    const norm = emotion.trim();
    if (norm) {
      contextTexts.unshift(norm.startsWith('用') ? norm : `用${norm}的语气说`);
    }
  }

  const configuredSpeed = Number(cfg?.speedRatio ?? 0.9);
  const speedRatio = Number.isFinite(configuredSpeed) ? configuredSpeed : 0.9;
  const speechRate = Math.max(-50, Math.min(100, Math.round((speedRatio - 1) * 100)));
  const reqParams = {
    text: actualText,
    speaker,
    audio_params: { format: 'mp3', sample_rate: 24000, bit_rate: 64000, speech_rate: speechRate }
  };

  // 确保 contextTexts 绝不为空！否则火山引擎会退化成没有感情的死板念稿
  if (contextTexts.length === 0) {
    if (style === 'gentle') {
      contextTexts.push('用温柔、体贴、轻声细语的治愈语气说');
    } else {
      contextTexts.push('用自然生动、略带娇憨傲娇的少女日常语气说话，带有自然的呼吸与音调起伏');
    }
  }

  // 通过 context_texts 引导 2.0 / ICL 渲染呼吸、哭腔与语气，不污染朗读正文
  if (contextTexts.length > 0 && (resourceId === 'seed-tts-2.0' || resourceId === 'seed-icl-2.0')) {
    reqParams.additions = JSON.stringify({ context_texts: [contextTexts.join('；')] });
  }

  console.log(`[TTS] 发起合成: speaker=${speaker}, textLength=${actualText.length}, hasEmotion=${contextTexts.length > 0}`);

  const payload = JSON.stringify({ req_params: reqParams });

  return new Promise((resolve, reject) => {
    const req = https.request('https://openspeech.bytedance.com/api/v3/tts/unidirectional', {
      method: 'POST',
      headers: {
        'X-Api-Key': apiKey,
        'X-Api-Resource-Id': resourceId,
        'X-Api-Request-Id': crypto.randomUUID(),
        'Content-Type': 'application/json'
      },
      timeout: 15000
    }, (res) => {
      let chunks = [];
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const d = JSON.parse(trimmed);
            if (d.data) {
              chunks.push(Buffer.from(d.data, 'base64'));
            }
          } catch (e) {}
        }
      });
      res.on('end', () => {
        const full = Buffer.concat(chunks);
        if (full.length > 0) {
          resolve({ ok: true, base64: full.toString('base64'), bytes: full.length, voice: `doubao:${speaker}` });
        } else {
          reject(new Error(`doubao empty audio, http status ${res.statusCode}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('doubao request timeout'));
    });
    req.write(payload);
    req.end();
  });
}

/**
 * Edge-TTS 兜底合成
 */
async function synthesizeEdge(clean, style, dir, timeoutMs) {
  const { cleanText } = extractEmotionAndCleanText(clean);
  const cleanForEdge = (cleanText || clean).replace(/\s+/g, ' ').trim();
  if (!cleanForEdge) return { ok: false, error: 'empty text for edge' };
  const voice = EDGE_VOICES[style] || EDGE_VOICES.cute;
  const rate = EDGE_RATES[style] || EDGE_RATES.cute;

  await fs.mkdir(dir, { recursive: true });
  const out = path.join(dir, `v_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.mp3`);

  try {
    await new Promise((resolve, reject) => {
      const child = spawn('edge-tts', [`--voice=${voice}`, `--rate=${rate}`, '--file=-', `--write-media=${out}`], { stdio: ['pipe', 'ignore', 'ignore'] });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('edge timeout')); }, timeoutMs);
      child.on('error', err => { clearTimeout(timer); reject(err); });
      child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('edge failed')); });
      child.stdin.on('error', () => {});
      child.stdin.end(cleanForEdge);
    });
    const buf = await fs.readFile(out);
    await fs.unlink(out).catch(() => {});
    if (!buf.length) return { ok: false, error: 'empty audio' };
    return { ok: true, base64: buf.toString('base64'), bytes: buf.length, voice: `edge:${voice}` };
  } catch (e) {
    await fs.unlink(out).catch(() => {});
    return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
  }
}

/**
 * 音频音量与响度动态增强 (EBU R128 标准化，峰值控制在 -1.0dB)
 */
function boostAudio(buffer) {
  return new Promise((resolve) => {
    const ff = spawn('ffmpeg', [
      '-y',
      '-i', 'pipe:0',
      '-filter:a', 'loudnorm=I=-14:TP=-1.0:LRA=7',
      '-f', 'mp3',
      'pipe:1'
    ]);
    const outChunks = [];
    ff.stdout.on('data', c => outChunks.push(c));
    ff.on('close', code => {
      if (code === 0 && outChunks.length > 0) {
        resolve(Buffer.concat(outChunks));
      } else {
        resolve(buffer);
      }
    });
    ff.on('error', () => resolve(buffer));
    ff.stdin.on('error', () => {});
    ff.stdin.end(buffer);
  });
}

// Conservative request budget in UTF-8 bytes; leaves room for provider emotion tags.
export function splitSpeechText(text, maxBytes = 600) {
  if (!Number.isInteger(maxBytes) || maxBytes < 4) throw new RangeError('invalid speech chunk limit');
  const parts = [];
  let remaining = String(text);
  while (Buffer.byteLength(remaining) > maxBytes) {
    let size = 0, end = 0, preferred = 0;
    for (const char of remaining) {
      const n = Buffer.byteLength(char);
      if (size + n > maxBytes) break;
      size += n; end += char.length;
      if (/[。！？!?；;，,\n]/u.test(char)) preferred = end;
    }
    const cut = preferred >= end / 2 ? preferred : end;
    parts.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining) parts.push(remaining);
  return parts;
}

/**
 * 合成一句话的语音。
 * @param {string} text 要说的话
 * @param {{style?: string, dir?: string, timeoutMs?: number}} opts
 * @returns {Promise<{ok: boolean, base64?: string, bytes?: number, voice?: string, error?: string}>}
 */
export async function synthesize(text, opts = {}) {
  const { style = 'cute', emotion = '', voiceEmotion = '', intensity = '', dir = './data/voice', timeoutMs = 45000 } = opts;
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return { ok: false, error: 'empty text' };
  const spokenText = extractEmotionAndCleanText(clean).cleanText;
  if (!spokenText) return { ok: false, error: 'empty text after removing voice directions' };

  const cfg = opts._ttsConfig ?? loadConfig();
  const provider = opts.provider;
  if (provider && !['fish', 'doubao', 'edge'].includes(provider)) return { ok: false, error: 'invalid voice provider' };
  const doubaoCfg = cfg?.tts?.provider === 'doubao' ? cfg.tts : null;

  let rawRes = null;

  // The user-approved Fish voice is primary when configured.
  if ((!provider || provider === 'fish') && cfg?.tts?.fish?.apiKey && cfg.tts.fish.referenceId) {
    try {
      const fishSpeech = fishText(spokenText, { emotion: voiceEmotion, intensity });
      if (!fishSpeech) return { ok: false, error: 'empty text after removing voice directions' };
      rawRes = await synthesizeFish(fishSpeech, cfg.tts.fish, Math.min(timeoutMs, 30000));
      console.log('[TTS] provider=fish fallback=false');
    } catch {
      console.warn('[TTS] provider=fish failed; fallback changes voice and may lose emotion');
    }
  }
  if (!rawRes && (!provider || provider === 'doubao') && doubaoCfg?.apiKey) {
    try {
      const safeFallbackEmotions = { angry: '生气', sad: '伤心', happy: '开心', gentle: '温柔', natural: '' };
      const fallbackEmotion = cfg?.tts?.fish?.apiKey ? (safeFallbackEmotions[voiceEmotion] || '') : emotion;
      const res = await synthesizeDoubao(cfg?.tts?.fish?.apiKey ? spokenText : clean, style, doubaoCfg, fallbackEmotion);
      if (res && res.ok && res.bytes > 0) {
        rawRes = res;
        console.warn('[TTS] provider=doubao fallback=true; voice and emotional rendering may differ');
      }
    } catch (e) {
      console.warn('[TTS] provider=doubao failed; trying edge');
    }
  }

  // Last resort changes both voice and emotional rendering.
  if (!rawRes && (!provider || provider === 'edge')) {
    console.warn('[TTS] provider=edge fallback=true; voice changed, emotion not preserved');
    rawRes = await synthesizeEdge(spokenText, style, dir, timeoutMs);
    if (!rawRes.ok) rawRes = { ok: false, error: 'all configured voice providers failed' };
  }

  if (rawRes && rawRes.ok && rawRes.base64) {
    try {
      const inBuf = Buffer.from(rawRes.base64, 'base64');
      const boostedBuf = await boostAudio(inBuf);
      return {
        ...rawRes,
        spokenText,
        base64: boostedBuf.toString('base64'),
        bytes: boostedBuf.length
      };
    } catch (e) {
      return { ...rawRes, spokenText };
    }
  }

  return rawRes;
}

export async function synthesizeChunks(text, opts = {}, synthesizePart = synthesize, providerOverride) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  const spoken = extractEmotionAndCleanText(normalized).cleanText;
  if (!spoken) return { ok: false, error: 'empty text' };
  const parts = splitSpeechText(spoken, opts.maxChunkBytes ?? 600);
  const directions = extractEmotionAndCleanText(normalized).contextTexts.join('；');
  const chunkOpts = { ...opts, emotion: [opts.emotion, directions].filter(Boolean).join('；') };
  // Snapshot configuration for the whole utterance. Each provider gets at most
  // one sequential pass; no segment is exposed until a complete pass succeeds.
  const cfg = synthesizePart === synthesize ? loadConfig() : null;
  const providers = providerOverride ?? (cfg ? [
    ...(cfg?.tts?.fish?.apiKey && cfg.tts.fish.referenceId ? ['fish'] : []),
    ...(cfg?.tts?.provider === 'doubao' && cfg.tts.apiKey ? ['doubao'] : []),
    'edge'
  ] : [undefined]);
  for (const provider of providers) {
    const chunks = [];
    let voice;
    for (const part of parts) {
      let result;
      try { result = await synthesizePart(part, { ...chunkOpts, ...(cfg ? { _ttsConfig: cfg } : {}), provider }); }
      catch { break; }
      if (!result?.ok || !result.base64 || !result.voice || (voice && result.voice !== voice)) break;
      voice = result.voice;
      chunks.push({ ...result, spokenText: part });
    }
    if (chunks.length === parts.length) return { ok: true, chunks, spokenText: spoken };
  }
  return { ok: false, error: 'speech chunk synthesis failed' };
}

export { synthesizeFish };
export default { synthesize, synthesizeChunks, synthesizeFish, TTS_STYLES };
