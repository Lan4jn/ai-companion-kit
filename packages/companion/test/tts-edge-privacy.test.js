import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { synthesize } from '../src/tts.js';

test('edge fallback carries speech via stdin not argv, and hides provider errors', async () => {
  const oldCwd = process.cwd(), oldPath = process.env.PATH;
  const d = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'tts-edge-test-'));
  try {
    await fs.writeFile(path.join(d, 'config.json'), JSON.stringify({tts:{fish:{apiKey:'fake-key',referenceId:'fake-ref'}}}));
    await fs.writeFile(path.join(d, 'curl'), '#!/bin/sh\nexit 1\n', {mode:0o755});
    await fs.writeFile(path.join(d, 'ffmpeg'), '#!/bin/sh\nexit 1\n', {mode:0o755});
    await fs.writeFile(path.join(d, 'edge-tts'), '#!/bin/sh\nprintf "%s\\n" "$@" > args\ncat > input\nfor x in "$@"; do case "$x" in --write-media=*) printf fakeaudio > "${x#--write-media=}";; esac; done\n', {mode:0o755});
    process.chdir(d); process.env.PATH = d + ':' + oldPath;
    const r = await synthesize('synthetic-private-speech', {dir:d});
    assert.equal(r.ok, true);
    const args = await fs.readFile('args','utf8');
    assert.ok(args.includes('--file=-'));
    assert.ok(!args.includes('synthetic-private-speech'));
    assert.equal(await fs.readFile('input','utf8'), 'synthetic-private-speech');
  } finally { process.chdir(oldCwd); process.env.PATH = oldPath; await fs.rm(d,{recursive:true,force:true}); }
});
