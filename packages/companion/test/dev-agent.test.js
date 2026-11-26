import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xy-dev-'));
process.env.XY_DEV_WORKDIR = dir;

const { executeDevAgent, DEV_AGENT_TOOLS } = await import('../src/dev-agent.js');

test('dev_task 只暴露一个工具，必填 task', () => {
  assert.equal(DEV_AGENT_TOOLS.length, 1);
  const fn = DEV_AGENT_TOOLS[0].function;
  assert.equal(fn.name, 'dev_task');
  assert.deepEqual(fn.parameters.required, ['task']);
});

test('拒绝过短的任务描述，不启动代理', async () => {
  const r = await executeDevAgent('dev_task', { task: '改' });
  assert.equal(r.success, false);
  assert.match(r.text, /太短/);
});

test('拒绝过长的任务描述', async () => {
  const r = await executeDevAgent('dev_task', { task: 'x'.repeat(2001) });
  assert.equal(r.success, false);
  assert.match(r.text, /太长/);
});

test('仓库不存在时直接失败，不会卡住', async () => {
  process.env.XY_DEV_REPO = path.join(dir, 'not-a-repo');
  try {
    const r = await executeDevAgent('dev_task', { task: '把 README 里加一行说明文字' });
    assert.equal(r.success, false);
    assert.match(r.text, /仓库/);
  } finally {
    delete process.env.XY_DEV_REPO;
  }
});

test('未知工具名被拒绝', async () => {
  const r = await executeDevAgent('nope', { task: '随便做点什么' });
  assert.equal(r.success, false);
});
