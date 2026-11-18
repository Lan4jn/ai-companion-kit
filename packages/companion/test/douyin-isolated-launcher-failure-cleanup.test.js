import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createIsolatedHeadedLauncher} from '../src/douyin-isolated-launcher-candidate.js';

test('failed launch retains original error even when broker cleanup throws', async () => {
  let fd, closes = 0;
  const launch = createIsolatedHeadedLauncher({
    allocateBroker() {
      fd = fs.openSync('/dev/null', 'r');
      return {fd, broker: {close() { closes++; throw Error('cleanup failure'); }}};
    },
    command: process.execPath,
    args() { throw Error('launch failure'); },
  });
  assert.throws(() => launch('', [], {env: {DOUYIN_LOGIN_SESSION_DIR: '/unused'}}), /launch failure/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closes, 1);
  assert.throws(() => fs.fstatSync(fd), {code: 'EBADF'});
});
