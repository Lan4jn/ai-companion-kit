// 小鱼的声音：优先使用豆包语音大模型 2.0 (seed-tts-2.0)，异常时自动回退到 edge-tts
// 输出 MP3 base64，交给 OneBot.sendVoice 发成 QQ 语音条。
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';

const run = promisify(execFile);

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
      if (code !== 0) return reject(new Error(`curl exit ${code}: ${Buffer.concat(err).toString().slice(0, 120)}`));
      if (buf.length < 512) return reject(new Error(`fish 返回内容过短(${buf.length}B): ${Buffer.concat(err).toString().slice(0, 120)}`));
      resolve(buf);
    });
    p.stdin.end(input);
  });
}

/**
 * fish.audio 兜底音色（zero-shot voice clone）。
 * 跨境 + 免费档排队，正常 3~5 秒，超时给到 30 秒。
 */
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
  const args = [
    '-sS', '--max-time', String(Math.ceil(timeoutMs / 1000)),
    '-X', 'POST', `${base}/tts`,
    '-H', `Authorization: Bearer ${fishCfg.apiKey}`,
    '-H', 'Content-Type: application/json',
    '-H', `model: ${model}`,
    '--data-binary', '@-',
  ];
  if (fishCfg.proxy) args.unshift('-x', fishCfg.proxy);
  const buf = await curlToBuffer(args, payload, timeoutMs);
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
  let match;
  while ((match = tagRegex.exec(text)) !== null) {
    const rawTag = (match[1] || match[2] || match[3] || '').trim();
    if (!rawTag) continue;
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
      contextTexts.push(rawTag.startsWith('用') ? rawTag : `用${rawTag}的语气说`);
    }
  }

  // 严格从朗读文本中剥离所有标记，防止 TTS 引擎念出字面
  const cleanText = text
    .replace(/\[[^\[\]]+\]/g, '')
    .replace(/\([^\(\)]+\)/g, '')
    .replace(/（[^（）]+）/g, '')
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

  const speedRatio = Number(cfg?.tts?.speedRatio || 0.9);
  const reqParams = {
    text: actualText,
    speaker,
    audio_params: { format: 'mp3', sample_rate: 24000, bit_rate: 64000, speed_ratio: speedRatio }
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
    reqParams.additions = JSON.stringify({ context_texts: contextTexts });
  }

  console.log(`[TTS] 发起合成: speaker=${speaker}, text="${actualText}", context_texts=${JSON.stringify(contextTexts)}`);

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
    await run(
      'edge-tts',
      [`--voice=${voice}`, `--rate=${rate}`, `--text=${cleanForEdge}`, `--write-media=${out}`],
      { timeout: timeoutMs },
    );
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
    ff.stdin.end(buffer);
  });
}

/**
 * 合成一句话的语音。
 * @param {string} text 要说的话
 * @param {{style?: string, dir?: string, timeoutMs?: number}} opts
 * @returns {Promise<{ok: boolean, base64?: string, bytes?: number, voice?: string, error?: string}>}
 */
export async function synthesize(text, opts = {}) {
  const { style = 'cute', emotion = '', dir = './data/voice', timeoutMs = 45000 } = opts;
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 280);
  if (!clean) return { ok: false, error: 'empty text' };

  const cfg = loadConfig();
  const doubaoCfg = cfg?.tts?.provider === 'doubao' ? cfg.tts : null;

  let rawRes = null;

  // 1. 尝试豆包语音合成 2.0
  if (doubaoCfg?.apiKey) {
    try {
      const res = await synthesizeDoubao(clean, style, doubaoCfg, emotion);
      if (res && res.ok && res.bytes > 0) {
        rawRes = res;
      }
    } catch (e) {
      console.warn(`[TTS] 豆包语音合成异常，尝试次级兜底: ${e?.message || e}`);
    }
  }

  // 2. 兜底 fish.audio（跨境的克隆音色，只在豆包失败时用）
  if (!rawRes && cfg?.tts?.fish?.apiKey) {
    try {
      const res = await synthesizeFish(clean, cfg.tts.fish, Math.min(timeoutMs, 30000));
      if (res && res.ok && res.bytes > 0) {
        rawRes = res;
        console.warn(`[TTS] 豆包不可用，已回退 fish.audio (${res.voice})`);
      }
    } catch (e) {
      console.warn(`[TTS] fish.audio 兜底失败，继续回退 edge-tts: ${e?.message || e}`);
    }
  }

  // 3. 最后兜底 edge-tts
  if (!rawRes) {
    rawRes = await synthesizeEdge(clean, style, dir, timeoutMs);
  }

  if (rawRes && rawRes.ok && rawRes.base64) {
    try {
      const inBuf = Buffer.from(rawRes.base64, 'base64');
      const boostedBuf = await boostAudio(inBuf);
      return {
        ...rawRes,
        base64: boostedBuf.toString('base64'),
        bytes: boostedBuf.length
      };
    } catch (e) {
      return rawRes;
    }
  }

  return rawRes;
}

export { synthesizeFish };
export default { synthesize, synthesizeFish, TTS_STYLES };
