import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { EncryptedChatJournal, startDurableChatRecovery } from '../src/chat-durable-journal-candidate.js';
import { DurableBatchCandidate } from '../src/chat-durable-batch-candidate.js';

test('legacy recovery refuses a batch journal before creating any control endpoint', async () => {
  const base = fs.mkdtempSync(path.join(process.env.TMPDIR, 'batch-recovery-isolation-'));
  const dir = path.join(base, 'data'); fs.mkdirSync(dir, {mode: 0o700});
  const control = path.join(base, 'control');
  let journal, server;
  try {
    journal = new EncryptedChatJournal({directory: dir, key: Buffer.alloc(32, 34)});
    const queue = new DurableBatchCandidate(journal);
    queue.accept('synthetic', {text:'private fixture'});
    queue.form('synthetic', 1, ['first', 'second']);
    queue.claim('synthetic');
    await assert.rejects(async () => { server = await startDurableChatRecovery(journal, {directory: control}); }, /batch|incompatible/i);
    assert.equal(fs.existsSync(control), false);
    assert.equal(queue.list('synthetic')[0].state, 'unknown');
    assert.equal(queue.claim('synthetic'), null);
  } finally {
    if (server) await server.close();
    if (journal && !journal.closed) journal.close();
    fs.rmSync(base, {recursive:true, force:true});
  }
});

test('legacy recovery fails closed if a batch journal appears after startup', async () => {
  const base = fs.mkdtempSync(path.join(process.env.TMPDIR, 'batch-recovery-live-'));
  const dir = path.join(base, 'data'); fs.mkdirSync(dir, {mode: 0o700});
  let journal, server;
  try {
    journal = new EncryptedChatJournal({directory: dir, key: Buffer.alloc(32, 35)});
    server = await startDurableChatRecovery(journal, {directory: path.join(base, 'control')});
    const queue = new DurableBatchCandidate(journal);
    queue.accept('synthetic', {text:'private fixture'});
    queue.form('synthetic', 1, ['first', 'second']);
    queue.claim('synthetic');
    const response = await new Promise((resolve, reject) => {
      const socket = net.createConnection(server.path); let data = '';
      socket.on('connect', () => socket.write('{"action":"list"}\n'));
      socket.on('data', chunk => { data += chunk; });
      socket.on('end', () => resolve(JSON.parse(data)));
      socket.on('error', reject);
    });
    assert.deepEqual(response, {ok:false});
    assert.equal(queue.list('synthetic')[0].state, 'unknown');
    assert.equal(queue.claim('synthetic'), null);
  } finally {
    if (server) await server.close();
    if (journal && !journal.closed) journal.close();
    fs.rmSync(base, {recursive:true, force:true});
  }
});
