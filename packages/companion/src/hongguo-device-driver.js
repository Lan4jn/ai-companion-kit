// Explicitly pinned device; no login, consent or inferred playback state.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extractHongguoCards } from './hongguo-cards.js';

const exec = promisify(execFile);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

export function createHongguoDeviceDriver({ serial, packageName, run = exec } = {}) {
  if (!nonempty(serial) || !/^[a-zA-Z][\w]*(?:\.[a-zA-Z][\w]*)+$/.test(packageName || '') || typeof run !== 'function') throw new Error('需要明确设备和应用包名');
  const adb = async (...args) => {
    const result = await run('adb', ['-s', serial, ...args], { encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
    if (args[0] === 'shell' && args[1] === 'uiautomator' && /error|could not|failed/i.test(String(result.stderr || ''))) throw new Error('UI hierarchy dump failed');
    return String(result.stdout);
  };
  const foreground = async () => {
    const data = await adb('shell', 'dumpsys', 'activity', 'activities');
    const lines = data.split(/\r?\n/).filter(line => /mResumedActivity|topResumedActivity/.test(line));
    const packages = lines.map(line => line.match(/\s([\w.]+)\/[\w.$]+/)?.[1]).filter(Boolean);
    return packages.length > 0 && packages.every(name => name === packageName);
  };
  const observeCards = async () => {
    if (!await foreground()) return { foreground: false, blocked: true, cards: [] };
    let dump;
    try { dump = await adb('shell', 'uiautomator', 'dump', '/sdcard/_hongguo_ui.xml'); }
    catch { return { foreground: true, blocked: true, cards: [] }; }
    if (/error|could not|failed/i.test(dump)) return { foreground: true, blocked: true, cards: [] };
    const xml = await adb('shell', 'cat', '/sdcard/_hongguo_ui.xml');
    if (!await foreground()) return { foreground: false, blocked: true, cards: [] };
    const cards = extractHongguoCards(xml);
    return { foreground: true, blocked: cards.length === 0, cards };
  };
  return {
    observeCards,
    async tapCard(selected) {
      const current = await observeCards();
      const matches = current.cards.filter(c => c.title === selected?.title && c.description === selected?.description && c.bounds === selected?.bounds);
      if (current.blocked || matches.length !== 1 || !await foreground()) return false;
      const b = selected.bounds.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/).slice(1).map(Number);
      await adb('shell', 'input', 'tap', String(Math.floor((b[0]+b[2])/2)), String(Math.floor((b[1]+b[3])/2)));
      return await foreground();
    },
    // The caller must configure an independently verified resource ID. Never guess
    // coordinates; both snapshots and the foreground must agree before tapping.
    async tapControl({ resourceId } = {}) {
      if (typeof resourceId !== 'string' || !resourceId.startsWith(`${packageName}:id/`) || !/^[\w.:/]+$/.test(resourceId)) throw new Error('缺少已确认控件');
      const readControl = async () => {
        if (!await foreground()) throw new Error('前台应用不匹配或无法确认');
        const xml = await adb('shell', 'uiautomator', 'dump', '/dev/tty');
        if (!xml.includes('<hierarchy') || !xml.includes('</hierarchy>') || /用户协议|隐私政策|同意并|登录|验证码|privacy policy|sign\s*in|terms of service/i.test(xml)) throw new Error('界面不明确或包含协议、登录');
        const nodes = [...xml.matchAll(/<node\s+[^>]*\/?\s*>/g)].map(m => m[0]);
        const found = nodes.filter(node => node.includes(`resource-id="${resourceId}"`));
        if (found.length !== 1 || !/\bclickable="true"/.test(found[0]) || !/\benabled="true"/.test(found[0])) throw new Error('控件不存在或不唯一');
        const bounds = found[0].match(/\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
        if (!bounds) throw new Error('控件位置不明确');
        const [x1, y1, x2, y2] = bounds.slice(1).map(Number);
        if (x2 <= x1 || y2 <= y1 || x2 > 10000 || y2 > 10000) throw new Error('控件位置无效');
        return [x1, y1, x2, y2];
      };
      const before = await readControl();
      const after = await readControl();
      if (before.some((n, i) => n !== after[i]) || !await foreground()) throw new Error('控件或前台发生变化');
      const [x1, y1, x2, y2] = after;
      await adb('shell', 'input', 'tap', String(Math.floor((x1 + x2) / 2)), String(Math.floor((y1 + y2) / 2)));
      if (!await foreground()) throw new Error('点击后前台应用不匹配');
      return { dispatched: true, verified: false };
    },
    async playback({ screenFallback = false } = {}) {
      if (!await foreground()) throw new Error('前台应用不匹配或无法确认');
      const data = await adb('shell', 'dumpsys', 'media_session');
      if (!await foreground()) throw new Error('读取播放状态期间前台应用发生变化');
      const blocks = data.split(/\r?\n(?=\s{0,4}[\w.]+\/[^\s]+\s+\(userId=\d+\))/);
      const matches = blocks.filter(block => new RegExp(`^\\s*${packageName.replace(/\./g, '\\.')}\\/[^\\s]+\\s+\\(userId=\\d+\\)`).test(block));
      if (matches.length === 0 && screenFallback) return { state: 'screen' };
      if (matches.length !== 1) throw new Error('播放会话不存在或不唯一');
      const states = [...matches[0].matchAll(/state=PlaybackState\s*\{state=(\d+),\s*position=(-?\d+),[^}]*?speed=([\d.-]+)/g)];
      const ids = [...matches[0].matchAll(/android\.media\.metadata\.MEDIA_ID=([^,}\s]+)/g)];
      if (states.length !== 1 || ids.length !== 1 || states[0][1] !== '3' || Number(states[0][3]) <= 0 || !Number.isSafeInteger(Number(states[0][2])) || Number(states[0][2]) < 0 || !nonempty(ids[0][1])) throw new Error('播放状态、进度或剧集标识不明确');
      return { state: 'playing', episodeId: ids[0][1], positionMs: Number(states[0][2]) };
    },
  };
}
