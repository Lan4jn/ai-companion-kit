import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHeadedDisplay } from '../src/douyin-headed-display.js';

const connect = (socket, token) => new Promise((resolve, reject) => {
  const s=net.createConnection(socket); s.on('error',()=>resolve({s,d:Buffer.alloc(0)})); s.on('connect',()=>s.write(token+'\n')); s.once('data', d=>resolve({s,d})); s.once('close',()=>resolve({s,d:Buffer.alloc(0)}));
});

test('private display admits exactly one claim and waits for cleanup after disconnect', {timeout:30000}, async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'headed-test-'));
  let display;
  try {
    display=await createHeadedDisplay({root, ttlMs:15000});
    assert.equal(fs.statSync(display.socket).mode & 0o777,0o600);
    const bad=await connect(display.socket,'bad'); assert.equal(bad.d.length,0);
    const first=await connect(display.socket,display.token); assert.match(first.d.toString(),/^RFB /);
    const replay=await connect(display.socket,display.token); assert.equal(replay.d.length,0);
    first.s.destroy(); await display.closed;
    assert.equal(fs.existsSync(display.socket),false);
    assert.equal(fs.existsSync(display.directory),false);
  } finally { if(display) await display.close(); fs.rmSync(root,{recursive:true,force:true}); }
});
