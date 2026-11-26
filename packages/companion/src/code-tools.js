/**
 * 代码工具 —— 让她在自己的隔离沙箱里写一小段代码、跑一下、看看结果。
 *
 * 设计要点：
 *   1. bwrap 起一个空命名空间：无网络（--unshare-all）、看不到 /root 和 /data，
 *      只有 /usr /bin /lib /lib64 只读，外加本次运行目录挂到 /work。
 *   2. 每次运行一个新目录 data/code-runs/run-XXXX，跑完保留，她可以后面接着看。
 *   3. 15 秒硬超时，输出截断到 4000 字（头 3000 + 尾 1000），不把整屏日志塞回上下文。
 *   4. 只对老爸本人开放（brain 的 OWNER_ONLY_TOOL_NAMES），群友和陌生私聊拿不到这个工具。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const LANGS = {
  javascript: 'javascript', js: 'javascript', node: 'javascript', mjs: 'javascript',
  python: 'python', py: 'python', python3: 'python',
};

const MAX_CODE = 20000;      // 代码本身最多 20KB
const MAX_OUTPUT = 4000;     // 回给模型的最多 4000 字
const TIMEOUT_MS = Number(process.env.XY_CODE_TIMEOUT_MS) > 0 ? Number(process.env.XY_CODE_TIMEOUT_MS) : 15000;    // 单次运行 15 秒（测试可用环境变量压缩）

export const CODE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'run_code',
      description: '在自己的隔离沙箱里运行一小段代码（JavaScript 或 Python），用来算数、处理文本、批量整理数据、生成小文件。没有网络，只能读写本次运行目录里的文件，最多跑 15 秒。',
      parameters: {
        type: 'object',
        properties: {
          language: { type: 'string', enum: ['javascript', 'python'], description: 'javascript 或 python' },
          code: { type: 'string', description: '要运行的完整代码，能直接 console.log / print 出结果' },
          note: { type: 'string', description: '一句话说明这次跑代码要干什么，只用于日志' },
        },
        required: ['language', 'code'],
      },
    },
  },
];

function sandboxRoot() {
  const base = process.env.XY_CODE_DIR || path.join(process.cwd(), 'data', 'code-runs');
  fs.mkdirSync(base, { recursive: true });
  return base;
}

/** 头尾各留一段，中间省略，避免一次把几万行日志灌进上下文 */
function clamp(text, limit = MAX_OUTPUT) {
  const s = String(text || '');
  if (s.length <= limit) return s;
  const head = s.slice(0, limit - 1000);
  const tail = s.slice(-1000);
  return `${head}\n…（中间省略 ${s.length - limit} 字）…\n${tail}`;
}

function listFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && !/^main\.(js|mjs|py)$/.test(e.name))
      .map((e) => {
        const st = fs.statSync(path.join(dir, e.name));
        return `${e.name} (${st.size} 字节)`;
      });
  } catch { return []; }
}

function bwrapArgs(dir, file) {
  return [
    '--ro-bind', '/usr', '/usr',
    '--ro-bind', '/bin', '/bin',
    '--ro-bind', '/lib', '/lib',
    '--ro-bind', '/lib64', '/lib64',
    '--ro-bind', '/etc/ld.so.cache', '/etc/ld.so.cache',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--bind', dir, '/work',
    '--chdir', '/work',
    '--unshare-all',
    '--die-with-parent',
    '--new-session',
    '--',
    ...file,
  ];
}

export function codeToolReady() {
  return fs.existsSync('/bin/bwrap') || fs.existsSync('/usr/bin/bwrap');
}

export async function executeCodeTool(name, args = {}) {
  if (name !== 'run_code') return { success: false, text: `未知工具: ${name}` };

  const lang = LANGS[String(args.language || '').toLowerCase()];
  if (!lang) return { success: false, text: '只支持 javascript 或 python。' };

  const code = String(args.code || '');
  if (!code.trim()) return { success: false, text: '代码是空的。' };
  if (code.length > MAX_CODE) return { success: false, text: `代码太长（${code.length} 字，上限 ${MAX_CODE}）。` };

  if (!codeToolReady()) return { success: false, text: '沙箱组件 bwrap 不可用，暂时跑不了代码。' };

  const dir = fs.mkdtempSync(path.join(sandboxRoot(), 'run-'));
  // require() 说明是 CJS 写法，其余按 ESM 跑；python 直接用 main.py
  const esm = lang === 'javascript' && !/\brequire\s*\(/.test(code);
  const filename = lang === 'javascript' ? (esm ? 'main.mjs' : 'main.js') : 'main.py';
  const abs = path.join(dir, filename);
  fs.writeFileSync(abs, code, { mode: 0o600 });

  const cmd = lang === 'javascript' ? '/usr/bin/node' : '/usr/bin/python3';
  const argv = bwrapArgs(dir, [cmd, `/work/${filename}`]);

  const started = Date.now();
  console.log(`[run_code] lang=${lang} note=${String(args.note || '').slice(0, 40)} len=${code.length}`);

  const result = await new Promise((resolve) => {
    const child = spawn('/bin/bwrap', argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
    }, TIMEOUT_MS);

    child.stdout.on('data', (b) => { out += b.toString('utf8'); });
    child.stderr.on('data', (b) => { out += b.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: out + `\n启动沙箱失败: ${e.message}`, timedOut }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, timedOut }); });
  });

  const ms = Date.now() - started;
  const files = listFiles(dir);
  const verdict = result.timedOut
    ? `超时（>${TIMEOUT_MS / 1000} 秒）被杀掉了`
    : `退出码 ${result.code}`;

  const parts = [`${verdict}，用时 ${ms}ms`];
  const body = clamp(result.out.trim());
  parts.push(body ? `输出：\n${body}` : '（没有任何输出）');
  if (files.length) parts.push(`这次生成的文件：${files.join('、')}`);
  parts.push(`目录：${dir}`);

  console.log(`[run_code] 结束 exit=${result.code} timeout=${result.timedOut} ms=${ms} files=${files.length}`);
  return { success: !result.timedOut && result.code === 0, text: parts.join('\n') };
}
