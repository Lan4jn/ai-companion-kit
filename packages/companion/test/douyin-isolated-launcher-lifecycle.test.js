import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createIsolatedHeadedLauncher} from '../src/douyin-isolated-launcher-candidate.js';

test('launcher allocates and closes a fresh broker for each service session', async () => {
  let allocated=0, closed=0;
  const launch=createIsolatedHeadedLauncher({
    allocateBroker() { allocated++; return {fd:fs.openSync('/dev/null','r'),broker:{close(){closed++;}}}; },
    command:process.execPath,
    args:()=>['-e','process.disconnect()'],
  });
  for (let i=0;i<2;i++) {
    const child=launch('',[],{env:{DOUYIN_LOGIN_SESSION_DIR:'/unused'}});
    await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  }
  assert.equal(allocated,2);
  assert.equal(closed,2);
});
