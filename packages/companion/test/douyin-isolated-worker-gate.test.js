import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import path from 'node:path';

test('reusable isolated worker is explicitly unavailable outside synthetic tests', () => {
  const env={...process.env}; delete env.NODE_TEST_CONTEXT;
  const result=spawnSync(process.execPath,[path.resolve('src/douyin-isolated-headed-worker.js')],{env,encoding:'utf8'});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/synthetic worker disabled/);
});
