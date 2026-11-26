import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 每次测试用独立的运行目录，避免污染生产 data/code-runs
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xy-code-'));
process.env.XY_CODE_DIR = dir;

const { executeCodeTool, CODE_TOOLS } = await import('../src/code-tools.js');

test('沙箱能跑通 javascript 和 python', async () => {
  const js = await executeCodeTool('run_code', { language: 'javascript', code: 'console.log(6*7)' });
  assert.equal(js.success, true);
  assert.match(js.text, /42/);

  const py = await executeCodeTool('run_code', { language: 'python', code: 'print(sum(range(10)))' });
  assert.equal(py.success, true);
  assert.match(py.text, /45/);
});

test('拒绝未知语言、空代码和超长代码', async () => {
  assert.equal((await executeCodeTool('run_code', { language: 'ruby', code: 'puts 1' })).success, false);
  assert.equal((await executeCodeTool('run_code', { language: 'python', code: '   ' })).success, false);
  assert.equal((await executeCodeTool('run_code', { language: 'python', code: 'x'.repeat(20001) })).success, false);
});

test('跑完能看到生成的文件，且写回运行目录', async () => {
  const r = await executeCodeTool('run_code', {
    language: 'python',
    code: 'open("note.txt","w").write("hi")\nprint("done")',
  });
  assert.equal(r.success, true);
  assert.match(r.text, /note\.txt/);
  const m = r.text.match(/目录：(.+)$/m);
  assert.ok(m, '应返回运行目录');
  assert.equal(fs.readFileSync(path.join(m[1].trim(), 'note.txt'), 'utf8'), 'hi');
});

test('沙箱里没有网络', async () => {
  const r = await executeCodeTool('run_code', {
    language: 'javascript',
    code: 'fetch("https://example.com").then(x=>console.log("通了",x.status)).catch(e=>console.log("挡了",e.cause?.code||e.name))',
  });
  assert.equal(r.success, true);
  assert.match(r.text, /挡了/);
  assert.doesNotMatch(r.text, /通了/);
});

test('沙箱里读不到 /root', async () => {
  const r = await executeCodeTool('run_code', {
    language: 'javascript',
    code: 'const fs=require("fs");try{console.log(fs.readdirSync("/root").length)}catch(e){console.log("读不到",e.code)}',
  });
  assert.match(r.text, /读不到/);
});

test('输出过长会截断，不把整屏日志塞回上下文', async () => {
  const r = await executeCodeTool('run_code', {
    language: 'python',
    code: 'print("x"*8000)',
  });
  assert.ok(r.text.length < 5000, `输出应被截断，实际 ${r.text.length}`);
  assert.match(r.text, /中间省略/);
});

test('超时会被杀掉', async () => {
  process.env.XY_CODE_TIMEOUT_MS = '1200';
  try {
    const r = await executeCodeTool('run_code', { language: 'python', code: 'while True:\n    pass' });
    assert.equal(r.success, false);
    assert.match(r.text, /超时/);
  } finally {
    delete process.env.XY_CODE_TIMEOUT_MS;
  }
});

test('工具声明只暴露 run_code，且必填 language/code', () => {
  assert.equal(CODE_TOOLS.length, 1);
  const fn = CODE_TOOLS[0].function;
  assert.equal(fn.name, 'run_code');
  assert.deepEqual(fn.parameters.required, ['language', 'code']);
});
