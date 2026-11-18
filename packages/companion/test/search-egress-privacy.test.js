import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeSearchTool } from '../src/search-tools.js';
import { buildTermHint } from '../src/term-lookup.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('private queries are rejected before any network call', async () => {
  let calls = 0; const old = globalThis.fetch;
  globalThis.fetch = async () => { calls++; throw Error('unexpected'); };
  try {
    for (const query of ['张三患了抑郁症查一下', '验证码是 abcdef 查一下', 'alice邮箱地址查一下', '不要搜索RTX 5080发售时间']) {
      assert.equal((await executeSearchTool('web_search', { query })).success, false);
    }
    assert.equal(calls, 0);
  } finally { globalThis.fetch = old; }
});

test('casual unknown fragments are neither searched nor cached', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lookup-isolated-'));
  let calls = 0; const old = globalThis.fetch;
  globalThis.fetch = async () => { calls++; throw Error('unexpected'); };
  try {
    assert.equal(await buildTermHint('验证码 abcdef', { dataDir: dir }), '');
    assert.equal(calls, 0);
    assert.equal(fs.existsSync(path.join(dir, 'term-cache.json')), false);
  } finally { globalThis.fetch = old; fs.rmSync(dir, {recursive:true, force:true}); }
});
