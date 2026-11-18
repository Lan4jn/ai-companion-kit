// Read-only capture. No navigation, consent, login, or playback controls are performed.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { assessViewing } from './hongguo-viewing.js';
import { assessScreenProgress, screenEpisodeId, detectPlayhead } from './hongguo-screen-progress.js';

const exec = promisify(execFile);
const wall = /用户协议|隐私政策|同意并继续|同意并使用|登录后|登录以|请先登录|手机号登录|验证码登录|扫码登录|注册登录|sign\s*in|privacy policy|terms of service/i;
const text = x => typeof x === 'string' && x.trim().length > 0;

// Playback data must come from a real source supplied by the caller; adb does not
// invent episode identities or playback positions. Foreground is checked around
// screenshot capture to avoid attributing another app's screen to Hongguo.
export function createAdbCapture({ serial, packageName, playback, run = exec, now = Date.now } = {}) {
  if (!text(serial) || !text(packageName) || typeof playback !== 'function') throw new Error('需要明确设备、应用包名和真实播放进度来源');
  const adb = (...args) => run('adb', ['-s', serial, ...args], { encoding: 'buffer', timeout: 15000, maxBuffer: 16 * 1024 * 1024 });
  async function foreground() {
    const { stdout } = await adb('shell', 'dumpsys', 'activity', 'activities');
    const line = String(stdout).split(/\r?\n/).find(l => /mResumedActivity|topResumedActivity/.test(l));
    const match = line?.match(/\s([\w.]+)\/[\w.$]+/);
    return match?.[1] || null;
  }
  return async () => {
    const before = await foreground();
    if (before !== packageName) throw new Error('前台应用不匹配或无法确认');
    const position = await playback({ serial, packageName });
    const { stdout } = await adb('exec-out', 'screencap', '-p');
    const capturedAt = now();
    const after = await foreground();
    if (after !== packageName) throw new Error('截图期间前台应用发生变化');
    return { ...position, serial, packageName, capturedAt, image: Buffer.from(stdout) };
  };
}

// Tesseract is intentionally an explicit dependency, never silently replaced by
// invented text. OCR text is screen text, not necessarily dialogue/subtitles.
export async function recognizeScreen(image, { language = 'chi_sim+eng', spawnProcess = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess('tesseract', ['stdin', 'stdout', '-l', language], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [], err = [];
    let size = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error('OCR 超时')); }, 30000);
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 4 * 1024 * 1024) { child.kill(); reject(new Error('OCR 输出过大')); } else out.push(chunk); });
    child.stderr.on('data', chunk => { if (err.reduce((n, x) => n + x.length, 0) < 65536) err.push(chunk); });
    child.stdin.on('error', reject);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`OCR 失败: ${Buffer.concat(err).toString().slice(0, 1024)}`));
      resolve(Buffer.concat(out).toString().split(/\r?\n/).map(s => s.trim()).filter(Boolean));
    });
    child.stdin.end(image);
  });
}

export async function decodeScreenProgress(image) {
  if (!Buffer.isBuffer(image) || image.length < 24 || !image.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return null;
  const width = image.readUInt32BE(16), height = image.readUInt32BE(20);
  if (!((width === 1920 && height === 1080) || (width === 1080 && height === 1920))) return null;
  return new Promise((resolve, reject) => {
    const child = spawn('convert', ['png:-', '-depth', '8', 'rgb:-'], { stdio: ['pipe','pipe','pipe'] });
    const chunks = []; let size = 0;
    const timer = setTimeout(() => child.kill(), 15000);
    child.stdout.on('data', b => { size += b.length; if (size > 1920*1080*3) child.kill(); else chunks.push(b); });
    child.stdin.on('error', reject); child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); if (code !== 0) return reject(new Error('图片解码失败')); resolve(detectPlayhead({data: Buffer.concat(chunks), width, height})); });
    child.stdin.end(image);
  });
}

export async function recognizeScreenIdentity(image, { ocrCrop: overrideCrop } = {}) {
  if (!Buffer.isBuffer(image) || image.length < 24) return null;
  const width = image.readUInt32BE(16), height = image.readUInt32BE(20);
  const portrait = width === 1080 && height === 1920;
  if (!portrait && (width !== 1920 || height !== 1080)) return null;
  // Use a bounded child pipeline for the two crops.
  const ocrCrop = overrideCrop || ((geometry, psm = 7) => new Promise((resolve, reject) => {
    const convert = spawn('convert', ['png:-', '-crop', geometry, '+repage', '-resize', '300%', '-colorspace', 'Gray', '-contrast-stretch', '1%x1%', 'png:-']);
    const tess = spawn('tesseract', ['stdin', 'stdout', '-l', 'chi_sim+eng', '--psm', String(psm)]);
    const chunks = []; let size = 0, settled = false;
    const finish = (err, value) => { if (settled) return; settled = true; clearTimeout(timer); if (err) { convert.kill(); tess.kill(); reject(err); } else resolve(value); };
    const timer = setTimeout(() => finish(new Error('身份 OCR 超时')), 30000);
    convert.on('error', e => finish(e)); tess.on('error', e => finish(e));
    convert.stdin.on('error', e => finish(e)); tess.stdin.on('error', e => finish(e));
    convert.on('close', code => { if (code !== 0) finish(new Error('身份图片裁剪失败')); });
    tess.stdout.on('data', b => { size += b.length; if (size > 65536) finish(new Error('身份 OCR 输出过大')); else chunks.push(b); });
    tess.on('close', code => code === 0 ? finish(null, Buffer.concat(chunks).toString().trim()) : finish(new Error('身份 OCR 失败')));
    convert.stdout.pipe(tess.stdin); convert.stdin.end(image);
  }));
  const titleGeometry = portrait ? '850x75+15+1630' : '650x75+15+790';
  const episodeGeometry = portrait ? '180x70+60+40' : '180x60+65+50';
  const [rawTitle, episodeLine, episodeSparse] = await Promise.all([ocrCrop(titleGeometry, portrait ? 11 : 13), ocrCrop(episodeGeometry, 7), ocrCrop(episodeGeometry, 11)]);
  const title = rawTitle.split(/[>›]/)[0].trim().replace(/[^\u4e00-\u9fffA-Za-z0-9]+$/g, '');
  const episodes = new Set([episodeLine, episodeSparse].flatMap(s => [...s.matchAll(/第\s*(\d+)\s*集/g)].map(m => m[1])));
  return title.replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, '').length >= 10 && episodes.size === 1 ? `${title}:第${[...episodes][0]}集` : null;
}

export async function observeHongguo({ serial, packageName, capture, recognize = recognizeScreen, screenIdentity, screenProgress = decodeScreenProgress, wait = ms => new Promise(r => setTimeout(r, ms)), intervalMs = 3000 } = {}) {
  const fail = reason => ({ verified: false, evidence: { frames: [], subtitles: [], screenText: [], audio: null }, limitations: [reason, '未采集音频，不能推断声音。'] });
  if (!text(serial) || !text(packageName) || typeof capture !== 'function' || typeof recognize !== 'function' || typeof wait !== 'function' || !Number.isFinite(intervalMs) || intervalMs <= 0) return fail('缺少明确设备、应用或观测来源');
  try {
    const frames = [];
    const positions = [];
    const screenText = [];
    // Take both time-separated screenshots before expensive OCR; player overlays
    // can disappear while OCR runs. Each capture independently checks foreground.
    const shots = [];
    for (let i = 0; i < 2; i++) {
      if (i) await wait(intervalMs);
      shots.push(await capture());
    }
    for (const shot of shots) {
      if (shot?.serial !== serial || shot?.packageName !== packageName) return fail('设备或前台应用不匹配');
      if (shot.state !== 'playing' && shot.state !== 'screen') return fail('播放状态不明确，或遇到协议、登录页面');
      if (!Buffer.isBuffer(shot.image) || shot.image.length === 0 || !Number.isFinite(shot.capturedAt)) return fail('缺少有效截图');
      const lines = await recognize(shot.image);
      if (!Array.isArray(lines) || lines.some(x => typeof x !== 'string')) return fail('屏幕文字识别结果无效');
      const clean = lines.map(x => x.trim()).filter(Boolean);
      if (wall.test(clean.join(' '))) return fail('检测到协议或登录页面，需用户自行处理');
      if (!clean.length) return fail('未识别到可核验的屏幕内容');
      frames.push({ capturedAt: shot.capturedAt, frameId: createHash('sha256').update(shot.image).digest('hex'), description: `屏幕识别文字：${clean.join(' ')}` });
      positions.push(shot.state === 'screen' ? { source: 'screen-progress', episodeId: screenIdentity ? await screenIdentity(shot.image) : (screenEpisodeId(clean) || await recognizeScreenIdentity(shot.image)), progress: await screenProgress(shot.image) } : { episodeId: shot.episodeId, positionMs: shot.positionMs });
      screenText.push(clean);
    }
    const assessment = assessViewing({ before: frames[0], after: frames[1], playbackBefore: positions[0], playbackAfter: positions[1] });
    if (positions.every(p => p.source === 'screen-progress')) {
      assessment.verified = assessScreenProgress({ ...frames[0], ...positions[0] }, { ...frames[1], ...positions[1] });
      if (assessment.verified) assessment.limitations = ['进度是屏幕滑块估计，不是播放时间；识别可能有误。', '未采集音频，不能推断声音。'];
    }
    assessment.evidence.screenText = screenText;
    if (assessment.verified) assessment.evidence.playback = positions[1];
    assessment.limitations.push('文字来自屏幕 OCR，可能有误，不保证是字幕；播放状态、集数和进度依赖外部来源。');
    return assessment;
  } catch (error) {
    return fail(`观测失败：${error instanceof Error ? error.message : String(error)}`);
  }
}
