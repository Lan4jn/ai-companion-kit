import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const text = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required`);
};

// Resolve symlinks even when the target or some parent directories do not exist yet.
function canonicalFile(input) {
  let remaining = path.resolve(input).split(path.sep).filter(Boolean);
  let resolved = path.parse(path.resolve(input)).root;
  let links = 0;
  while (remaining.length) {
    const candidate = path.join(resolved, remaining.shift());
    let stat;
    try { stat = fs.lstatSync(candidate); }
    catch (error) {
      if (error.code === 'ENOENT') return path.join(candidate, ...remaining);
      throw error;
    }
    if (stat.isSymbolicLink()) {
      if (++links > 40) throw new Error('too many symlinks in goal file path');
      const target = path.resolve(path.dirname(candidate), fs.readlinkSync(candidate));
      remaining = [...target.split(path.sep).filter(Boolean), ...remaining];
      resolved = path.parse(target).root;
    } else {
      if (!remaining.length && stat.isFile() && stat.nlink > 1) throw new Error('hard-linked goal files are unsupported');
      resolved = candidate;
    }
  }
  return resolved;
}

function createGoalCoreInternal({ file }, locked) {
  text(file, 'file');
  file = canonicalFile(file);
  const load = () => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return { version: 1, goals: {}, desires: {}, events: {} };
      throw error;
    }
  };
  // flock owns a stable inode; never unlink it. The kernel releases the lock even
  // if a writer dies. A fresh subprocess makes this work with the synchronous API.
  const transaction = (method, argument) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const script = fs.readFileSync(new URL(import.meta.url), 'utf8') + `
      try {
        const { file, method, argument } = JSON.parse(fs.readFileSync(0, 'utf8'));
        const result = createGoalCoreInternal({ file }, true)[method](argument);
        process.stdout.write(JSON.stringify({ result: result ?? null }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ error: { name: error.name, message: error.message, code: error.code } }));
      }`;
    const child = spawnSync('flock', ['-x', '-w', '30', `${file}.lock`, process.execPath,
      '--input-type=module', '-e', script], { input: JSON.stringify({ file, method, argument }), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (child.error) throw child.error;
    if (child.status !== 0) throw new Error(`goal lock transaction failed (${child.status}): ${child.stderr || 'lock timeout or process failure'}`);
    const response = JSON.parse(child.stdout);
    if (response.error) {
      const ErrorType = { TypeError, SyntaxError, RangeError }[response.error.name] || Error;
      const error = new ErrorType(response.error.message);
      if (response.error.code) error.code = response.error.code;
      throw error;
    }
    return response.result === null ? undefined : response.result;
  };
  const save = state => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(tmp, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(state, null, 2)); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(tmp, file);
      const dir = fs.openSync(path.dirname(file), 'r');
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    }
    finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  };
  return {
    snapshot: () => structuredClone(load()),
    claimWebResearch({ goal, desire }) {
      if (!locked) return transaction('claimWebResearch', { goal, desire });
      text(goal?.id, 'goal id'); text(goal?.title, 'goal title');
      text(desire?.id, 'desire id'); text(desire?.title, 'desire title');
      if (goal.id !== desire.goalId || goal.target !== 1) throw new Error('invalid web claim');
      const meta = JSON.parse(goal.title);
      if (meta.kind !== 'web-deep-search' || typeof meta.topic !== 'string') throw new Error('invalid web topic');
      const normalize = s => s.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
      const key = normalize(meta.topic);
      if (key.length < 2) throw new Error('invalid normalized topic');
      const state = load();
      for (const d of Object.values(state.desires)) {
        const g = state.goals[d.goalId];
        if (d.status !== 'active' || g?.status !== 'active') continue;
        let prior;
        try { prior = JSON.parse(g.title); } catch { continue; }
        if (prior.kind === 'web-deep-search' && typeof prior.topic === 'string' && normalize(prior.topic) === key) return { claimed: false, desireId: d.id };
      }
      if (Object.hasOwn(state.goals, goal.id) || Object.hasOwn(state.desires, desire.id)) throw new Error('claim id exists');
      state.goals[goal.id] = { ...goal, progress: 0, status: 'active' };
      state.desires[desire.id] = { ...desire, status: 'active' };
      save(state);
      return { claimed: true, desireId: desire.id };
    },
    setWebResearchReason({ goalId, reason }) {
      if (!locked) return transaction('setWebResearchReason', { goalId, reason });
      text(goalId, 'goal id');
      if (typeof reason !== 'string' || reason.length > 60) throw new TypeError('invalid reason');
      const state = load();
      const goal = Object.hasOwn(state.goals, goalId) && state.goals[goalId];
      if (!goal || goal.status !== 'active' || JSON.parse(goal.title).kind !== 'web-deep-search') throw new Error('invalid active web goal');
      goal.reason = reason;
      save(state);
    },
    ensureGoalDesire({ goal, desire, reuseActiveTitle = false }) {
      if (!locked) return transaction('ensureGoalDesire', { goal, desire, reuseActiveTitle });
      text(goal?.id, 'goal id'); text(goal?.title, 'goal title');
      if (!Number.isFinite(goal.target) || goal.target <= 0) throw new TypeError('target must be positive');
      text(desire?.id, 'desire id'); text(desire?.title, 'desire title'); text(desire?.goalId, 'goalId');
      if (desire.goalId !== goal.id) throw new Error('goalId mismatch');
      const state = load();
      const selected = reuseActiveTitle && Object.values(state.goals).find(g => g.status === 'active' && g.title === goal.title && g.target === goal.target);
      const actualGoal = selected || (Object.hasOwn(state.goals, goal.id) && state.goals[goal.id]);
      if (actualGoal && (actualGoal.status !== 'active' || actualGoal.title !== goal.title || actualGoal.target !== goal.target)) throw new Error('goal conflict');
      const goalId = actualGoal?.id || goal.id;
      const active = reuseActiveTitle && Object.values(state.desires).find(d => d.goalId === goalId && d.status === 'active');
      if (active) return { goalId, desireId: active.id };
      if (Object.hasOwn(state.desires, desire.id)) throw new Error('desire exists');
      if (!actualGoal) Object.defineProperty(state.goals, goalId, { value: { ...goal, progress: 0, status: 'active' }, enumerable: true, writable: true, configurable: true });
      Object.defineProperty(state.desires, desire.id, { value: { id: desire.id, title: desire.title, goalId, status: 'active' }, enumerable: true, writable: true, configurable: true });
      save(state);
      return { goalId, desireId: desire.id };
    },
    addGoal({ id, title, target }) {
      if (!locked) return transaction('addGoal', { id, title, target });
      text(id, 'id'); text(title, 'title');
      if (!Number.isFinite(target) || target <= 0) throw new TypeError('target must be positive');
      const state = load();
      if (Object.hasOwn(state.goals, id)) throw new Error('goal exists');
      Object.defineProperty(state.goals, id, { value: { id, title, target, progress: 0, status: 'active' }, enumerable: true, writable: true, configurable: true });
      save(state);
    },
    addDesire({ id, title, goalId }) {
      if (!locked) return transaction('addDesire', { id, title, goalId });
      text(id, 'id'); text(title, 'title'); text(goalId, 'goalId');
      const state = load();
      if (!Object.hasOwn(state.goals, goalId)) throw new Error('unknown goal');
      if (Object.hasOwn(state.desires, id)) throw new Error('desire exists');
      Object.defineProperty(state.desires, id, { value: { id, title, goalId, status: 'active' }, enumerable: true, writable: true, configurable: true });
      save(state);
    },
    record(event) {
      if (!locked) return transaction('record', event);
      text(event?.id, 'event id'); text(event?.type, 'event type');
      const state = load();
      if (Object.hasOwn(state.events, event.id)) {
        if (JSON.stringify(state.events[event.id]) !== JSON.stringify(event)) throw new Error('event id conflict');
        return { applied: false };
      }
      if (event.type === 'goal.progress') {
        text(event.evidence?.source, 'evidence source'); text(event.evidence?.ref, 'evidence ref');
        const goal = Object.hasOwn(state.goals, event.goalId) && state.goals[event.goalId];
        if (!goal) throw new Error('unknown goal');
        if (goal.status !== 'active') throw new Error('goal closed');
        if (!Number.isFinite(event.amount) || event.amount <= 0) throw new TypeError('amount must be positive');
        goal.progress = Math.min(goal.target, goal.progress + event.amount);
        if (goal.progress === goal.target) goal.status = 'completed';
      } else if (event.type === 'goal.failed') {
        text(event.reason, 'reason');
        const goal = Object.hasOwn(state.goals, event.goalId) && state.goals[event.goalId];
        if (!goal) throw new Error('unknown goal');
        if (goal.status !== 'active') throw new Error('goal closed');
        goal.status = 'failed';
      } else if (event.type === 'desire.completed' || event.type === 'desire.refused' || event.type === 'desire.failed') {
        if (event.type === 'desire.completed') {
          text(event.evidence?.source, 'evidence source'); text(event.evidence?.ref, 'evidence ref');
        } else text(event.reason, 'reason');
        const desire = Object.hasOwn(state.desires, event.desireId) && state.desires[event.desireId];
        if (!desire) throw new Error('unknown desire');
        if (desire.status !== 'active') throw new Error('desire closed');
        if (event.type === 'desire.completed') {
          if (!Number.isFinite(event.amount) || event.amount <= 0) throw new TypeError('amount must be positive');
          const goal = state.goals[desire.goalId];
          if (!goal || goal.status !== 'active') throw new Error('goal closed');
          goal.progress = Math.min(goal.target, goal.progress + event.amount);
          if (goal.progress === goal.target) goal.status = 'completed';
        }
        desire.status = event.type.slice('desire.'.length);
        desire.outcomeEventId = event.id;
        // Some one-shot goals have no remaining work once their only desire fails.
        // Close both in the same transaction so a crash cannot strand the goal.
        if (event.type === 'desire.failed' && event.closeGoal === true) {
          const goal = state.goals[desire.goalId];
          if (!goal || goal.status !== 'active') throw new Error('goal closed');
          goal.status = 'failed';
        }
      } else throw new Error('unknown event type');
      Object.defineProperty(state.events, event.id, { value: structuredClone(event), enumerable: true, writable: true, configurable: true });
      save(state);
      return { applied: true };
    }
  };
}

export function createGoalCore({ file }) {
  return createGoalCoreInternal({ file }, false);
}
