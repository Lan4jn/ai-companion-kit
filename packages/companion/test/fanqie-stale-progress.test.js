import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import path from 'node:path';
import { phoneMutex } from '../src/phone-mutex.js';
import { getReaderProgress } from '../src/fanqie-reading.js';

test('failed accessibility dump cannot reuse stale reader progress', async () => {
 const dir = await mkdtemp(path.join(process.env.TMPDIR, 'fanqie-dump-test-'));
 const oldPath=process.env.PATH, oldSerial=process.env.PHONE_SERIAL;
 try {
  const adb=path.join(dir,'adb');
  await writeFile(adb, `#!/bin/sh\ncase "$*" in\n *dumpsys*) echo 'mCurrentFocus=com.dragon.read/.ReaderActivity';;\n *uiautomator*) echo 'UI hierchary dumped to: /sdcard/window.xml'; echo 'ERROR: could not get idle state.' >&2;;\n *cat*) echo '<node text="第1章"/><node text="3/100"/>';;\nesac\n`);
  await chmod(adb,0o755); process.env.PATH=dir+':'+oldPath; process.env.PHONE_SERIAL='dedicated';
  await phoneMutex.runUser(async()=>assert.equal(await getReaderProgress('dedicated'),null));
 } finally { process.env.PATH=oldPath; if(oldSerial===undefined)delete process.env.PHONE_SERIAL;else process.env.PHONE_SERIAL=oldSerial; await rm(dir,{recursive:true,force:true}); }
});
