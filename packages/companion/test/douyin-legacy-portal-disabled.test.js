import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Run only in the disposable network namespace with a synthetic daemon.
test('standalone legacy portal cannot restart login or accept verification codes', {skip: process.env.SYNTHETIC_LEGACY_ROUTE_TEST !== '1'}, async () => {
  const marker = process.env.SYNTHETIC_DAEMON_MARKER;
  assert.ok(marker && path.dirname(marker) === os.tmpdir());
  const child = spawn(process.execPath, ['src/douyin-login-portal.js'], {stdio: 'ignore'});
  try {
    const base = 'http://127.0.0.1:18080';
    let response;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) break;
      try { response = await fetch(base + '/restart', {method:'POST'}); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 30)); }
    }
    assert.ok(response, 'portal did not listen');
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {state:'disabled'});
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.equal((await fetch(base + '/code', {method:'POST', body:'synthetic'})).status, 503);
    assert.equal((await fetch(base + '/qr.png')).status, 503);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(fs.existsSync(marker), false);
  } finally {
    child.kill('SIGTERM');
    if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once('exit', resolve));
  }
});
