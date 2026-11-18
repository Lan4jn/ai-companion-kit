import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('growth check uses configured account headers after a scheduled watch', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'bili-growth-test-'));
  try {
    const script = `
      import { startBiliLiving, stopBiliLiving } from './src/bili-living.js';
      let seen = [];
      globalThis.fetch = async (url, options) => {
        seen.push({url, cookie: options.headers.cookie});
        return {json: async () => ({code:0, data:{level_info:{current_level:2},money:3,task_info:{}}})};
      };
      startBiliLiving({brain:{complete:async()=>'{"want":true}'}, credentials:{sessdata:'synthetic',bili_jct:'synthetic_csrf'}, skipChance:0, initialDelayMs:0, backgroundWork:async()=>({played:false})});
      await new Promise(r=>setTimeout(r,150));
      await stopBiliLiving();
      console.log('TEST_RESULT '+JSON.stringify(seen));
    `;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), env: {...process.env, HOME:home}, encoding:'utf8', timeout:10000 });
    assert.equal(r.status, 0, r.stderr);
    const result = JSON.parse(r.stdout.match(/TEST_RESULT (.*)/)[1]);
    assert.equal(result.length, 2, r.stdout);
    assert.ok(result.every(x => x.cookie === 'SESSDATA=synthetic; bili_jct=synthetic_csrf; buvid3='), JSON.stringify(result));
  } finally { rmSync(home, {recursive:true, force:true}); }
});
