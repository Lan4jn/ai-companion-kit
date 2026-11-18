import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { POOL } from './mood.js';

// Only fixed vocabulary crosses this boundary; never include free text or session moods.
const INTERESTS = ['游戏', '猫咪', '猫', '狗', '音乐', '电影', '动漫', '读书', '美食', '旅行', '摄影'];
export async function tiebaDecisionContext({ dir, reader, now = new Date() } = {}) {
  const context = { 当前时间UTC: now.toISOString(), 当前本地时间: now.toString(), 最近贴吧兴趣记录: [], 近期贴吧兴趣摘要: [], 已存放空欲望中的相关词: [], 今日心情基线: null };
  try { context.最近贴吧兴趣记录 = await reader?.decisionContext?.() || []; } catch {}
  context.近期贴吧兴趣摘要 = [...new Set(context.最近贴吧兴趣记录.flatMap(r => r.keywords))];
  if (!dir) return context;
  const read = async name => { try { return JSON.parse(await readFile(path.join(dir, name), 'utf8')); } catch { return {}; } };
  const [moods, desires] = await Promise.all([read('mood.json'), read('goals-desires.json')]);
  const day = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  context.今日心情基线 = POOL.find(m => m.key === moods?.[day]?.key)?.label || null;
  const idle = desires?.activeDesires?.idle?.title;
  if (typeof idle === 'string') context.已存放空欲望中的相关词 = INTERESTS.filter(word => idle.includes(word));
  return context;
}
