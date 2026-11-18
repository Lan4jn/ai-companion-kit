import { createHash } from 'node:crypto';
import { currentFanqieNavigation } from './fanqie-runner.js';

const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const hash = value => createHash('sha256').update(value).digest('hex');

// Wrap the integration's save(memoryDir, record) callback. The caller explicitly
// binds an existing desire and expected book; neither is inferred or created.
export function createFanqieGoalSave({ core, desireId, bookTitle, save }) {
 if (!core || typeof core.record !== 'function' || typeof core.snapshot !== 'function' || !nonempty(desireId) || !nonempty(bookTitle) || typeof save !== 'function') throw new TypeError('core, desireId, bookTitle and save are required');
 return async (dir, record) => {
  await save(dir, record);
  const p = record?.progress;
  if (!nonempty(record?.text) || (record.text.match(/[\u4e00-\u9fff]/g) || []).length < 65 || currentFanqieNavigation()?.bookTitle !== bookTitle || record.source !== '番茄小说屏幕OCR（可能存在识别错误）' || record.bookTitle !== bookTitle || record.fingerprint !== hash(record.text) || !p || !Number.isSafeInteger(p.page) || !Number.isSafeInteger(p.total) || p.page < 1 || p.page > p.total) return { applied:false, reason:'insufficient-reading-evidence' };
  const state = await core.snapshot();
  const desire = Object.hasOwn(state?.desires || {}, desireId) ? state.desires[desireId] : null;
  const goal = desire && Object.hasOwn(state?.goals || {}, desire.goalId) ? state.goals[desire.goalId] : null;
  if (!desire || desire.status !== 'active' || !goal || goal.status !== 'active') return {applied:false, reason:'no-active-goal-desire'};
  const evidence = {source:record.source, bookTitle:record.bookTitle, text:record.text, fingerprint:record.fingerprint, progress:{chapter:p.chapter ?? null,page:p.page,total:p.total}};
  const ref = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(evidence))}`;
  return core.record({id:`fanqie:${hash(JSON.stringify([desireId,record.fingerprint]))}`,type:'desire.completed',desireId,amount:1,evidence:{source:record.source,ref}});
 };
}
