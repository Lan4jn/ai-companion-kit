/**
 * 开发代理 —— 让她能在**独立分支**上改自己的代码。
 *
 * 边界：
 *   1. 改动只发生在 repo 的一个临时 worktree 里，分支名 xiaoyu/task-<时间戳>，
 *      永远不碰生产目录 companion-v2，也不会直接合并到 main。
 *   2. opencode 跑在 bwrap 里：只有这个 worktree 可写，系统目录只读，
 *      看不到 /root 的其它东西（她的 data、密钥、别的项目）。
 *   3. 跑完自动在分支上提交，把 diffstat 交回给她和老爸看；
 *      要不要合并由老爸决定（老爸说“合”才合）。
 *   4. 同一时间只允许一个任务，避免两个 worktree 抢同一个 repo。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const OPENCODE = process.env.XY_OPENCODE || `${process.env.HOME || '/root'}/.opencode/bin/opencode`;
const MODEL = process.env.XY_DEV_MODEL || 'ark/deepseek-v4-1-flash-261017';
const TIMEOUT_MS = Number(process.env.XY_DEV_TIMEOUT_MS) > 0 ? Number(process.env.XY_DEV_TIMEOUT_MS) : 420000;

export const DEV_AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'dev_task',
      description: '在独立分支上改自己的代码（改功能、修 bug、补测试）。改动只提交到 xiaoyu/* 分支，不碰线上；跑完会告诉你改了哪些文件、测试有没有过，要不要合并由老爸决定。任务要写清楚要什么效果。',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: '要做什么，越具体越好，例如“给面板加一个显示今日搜索次数的区块，并补测试”' },
        },
        required: ['task'],
      },
    },
  },
];

function repoPath() {
  return process.env.XY_DEV_REPO || '/root/ai-companion-xiaoyu/ai-companion-kit';
}

function workRoot() {
  const base = process.env.XY_DEV_WORKDIR || '/root/ai-companion-xiaoyu/dev-agent-work';
  fs.mkdirSync(base, { recursive: true });
  return base;
}

function lockFile() {
  return path.join(workRoot(), '.lock');
}

function acquireLock() {
  const f = lockFile();
  try {
    const fd = fs.openSync(f, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

function releaseLock() {
  try { fs.unlinkSync(lockFile()); } catch { /* 已经没了 */ }
}

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60000 });
  return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') };
}

function bwrapArgs(worktree) {
  const home = process.env.HOME || '/root';
  return [
    '--ro-bind', '/usr', '/usr',
    '--ro-bind', '/bin', '/bin',
    '--ro-bind', '/lib', '/lib',
    '--ro-bind', '/lib64', '/lib64',
    '--ro-bind', '/etc/ssl', '/etc/ssl',
    '--ro-bind', '/etc/resolv.conf', '/etc/resolv.conf',
    '--ro-bind', '/etc/ld.so.cache', '/etc/ld.so.cache',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    // opencode 本体和它的配置只读；会话/缓存目录可写，否则它会报错
    '--ro-bind', `${home}/.opencode`, `${home}/.opencode`,
    '--ro-bind', `${home}/.config/opencode`, `${home}/.config/opencode`,
    '--dir', `${home}/.local/share`,
    '--bind', `${home}/.local/share/opencode`, `${home}/.local/share/opencode`,
    // 唯一可写的代码目录
    '--bind', worktree, worktree,
    '--chdir', worktree,
    '--unshare-pid',
    '--die-with-parent',
    '--new-session',
    '--setenv', 'HOME', home,
    '--',
    OPENCODE, 'run', '--model', MODEL,
  ];
}

export function devAgentReady() {
  return fs.existsSync(OPENCODE) && fs.existsSync('/bin/bwrap');
}

export async function executeDevAgent(name, args = {}) {
  if (name !== 'dev_task') return { success: false, text: `未知工具: ${name}` };

  const task = String(args.task || '').trim();
  if (task.length < 6) return { success: false, text: '任务描述太短，说清楚要改什么。' };
  if (task.length > 2000) return { success: false, text: '任务描述太长（上限 2000 字）。' };
  if (!devAgentReady()) return { success: false, text: '开发代理没装好（缺 opencode 或 bwrap），暂时改不了代码。' };

  const repo = repoPath();
  if (!fs.existsSync(path.join(repo, '.git'))) return { success: false, text: '找不到代码仓库，改不了。' };

  if (!acquireLock()) return { success: false, text: '上一个开发任务还在跑，等它结束再来。' };

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const branch = `xiaoyu/task-${stamp}`;
  const worktree = path.join(workRoot(), `wt-${stamp}`);

  try {
    const base = git(['rev-parse', '--verify', 'origin/main'], repo).ok ? 'origin/main' : 'main';
    const wt = git(['worktree', 'add', '-b', branch, worktree, base], repo);
    if (!wt.ok) return { success: false, text: `建分支失败：${wt.out.slice(0, 200)}` };

    console.log(`[dev_task] 开始 branch=${branch} taskLen=${task.length}`);

    const started = Date.now();
    const run = await new Promise((resolve) => {
      const child = spawn('/bin/bwrap', [...bwrapArgs(worktree), task], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }, TIMEOUT_MS);
      child.stdout.on('data', (b) => { out += b.toString('utf8'); });
      child.stderr.on('data', (b) => { out += b.toString('utf8'); });
      child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: out + `\n启动失败: ${e.message}`, timedOut }); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, timedOut }); });
    });
    const ms = Date.now() - started;

    const status = git(['status', '--porcelain'], worktree).out.trim();
    const changed = status ? status.split('\n').length : 0;
    let stat = '';
    if (changed) {
      git(['add', '-A'], worktree);
      git(['-c', 'user.name=xiaoyu', '-c', 'user.email=xiaoyu@local', 'commit', '-q', '-m', `xiaoyu: ${task.slice(0, 60)}`], worktree);
      stat = git(['diff', '--stat', `${base}...HEAD`], worktree).out.trim().split('\n').slice(-1)[0] || '';
    }

    const tail = run.out.trim().slice(-1500);
    console.log(`[dev_task] 结束 exit=${run.code} timeout=${run.timedOut} ms=${ms} files=${changed} branch=${branch}`);

    const lines = [];
    lines.push(run.timedOut ? `超时（>${TIMEOUT_MS / 1000} 秒）被停了` : `代理退出码 ${run.code}，用时 ${Math.round(ms / 1000)} 秒`);
    lines.push(changed ? `改了 ${changed} 个文件，已提交到分支 ${branch}${stat ? `（${stat}）` : ''}` : '没有产生任何改动');
    if (tail) lines.push(`代理最后的输出：\n${tail}`);
    lines.push(`分支：${branch}｜工作区：${worktree}`);
    if (changed) lines.push('要不要合并由老爸定，你说“合”我再合，线上代码现在没被动过。');

    return { success: !run.timedOut && run.code === 0, text: lines.join('\n') };
  } finally {
    releaseLock();
  }
}
