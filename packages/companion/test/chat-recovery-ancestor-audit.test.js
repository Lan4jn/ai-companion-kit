import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { startChatRecovery } from '../src/chat-recovery.js';

test('rejects an ancestor symlink even if immediate parent is private', async () => {
  const base = await mkdtemp('/run/chat-ancestor-');
  try {
    await mkdir(join(base, 'real'), {mode:0o700});
    await mkdir(join(base, 'real', 'child'), {mode:0o700});
    await symlink(join(base, 'real'), join(base, 'link'));
    await assert.rejects(startChatRecovery({failed:new Set()}, {directory:join(base,'link','child','control')}), /unsafe/);
  } finally { await rm(base, {recursive:true,force:true}); }
});
