import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startVirtualRoomServer } from '../src/virtual-room.js';
import { fork } from 'node:child_process';
import { once } from 'node:events';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
test('room stop drains every accepted HTTP Douyin browse', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'room-drain-'));
  const releases = [];
  const room = startVirtualRoomServer({ port: 0, host: '127.0.0.1', dataDir: dir, douyinLiving: { browseDouyinLive: () => new Promise(resolve => releases.push(resolve)) } });
  try {
    const {port} = await room.ready;
    const url = `http://127.0.0.1:${port}/api/action`;
    for (let i=0; i<2; i++) assert.equal((await fetch(url, {method:'POST', body:JSON.stringify({action:'douyin'})})).status, 200);
    assert.equal(releases.length, 2);
    let done = false;
    const stopping = room.stop().then(() => { done = true; });
    await delay(30); assert.equal(done, false);
    releases[0](); await delay(30); assert.equal(done, false);
    releases[1](); await stopping; assert.equal(done, true);
  } finally { releases.forEach(fn => fn()); await room.stop(); fs.rmSync(dir,{recursive:true,force:true}); }
});

for (const mode of ['resolve','reject','timeout']) test(`real SIGTERM waits for room HTTP task: ${mode}`, async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'room-signal-'));
  const child = fork(new URL('./fixtures/room-douyin-signal.js', import.meta.url), [], {env:{...process.env,FIXTURE_DIR:dir,MODE:mode},stdio:['ignore','ignore','ignore','ipc']});
  const exited = once(child, 'exit');
  try {
    const [{port}] = await once(child, 'message');
    const started = once(child, 'message');
    const response = await fetch(`http://127.0.0.1:${port}/api/action`, {method:'POST',body:JSON.stringify({action:'douyin'})});
    assert.equal(response.status,200);
    assert.equal((await started)[0].event,'started');
    child.kill('SIGTERM');
    await delay(80);
    assert.equal(child.exitCode,null);
    if (mode !== 'timeout') child.send('release');
    const [code, signal] = await exited;
    assert.equal(signal,null);
    assert.equal(code,mode === 'resolve' ? 0 : 1);
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); await exited; fs.rmSync(dir,{recursive:true,force:true}); }
});
