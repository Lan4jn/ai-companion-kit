import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, chmod, symlink, lstat, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { ChatBatchQueue } from '../src/chat-batch-queue.js';
import { startChatRecovery } from '../src/chat-recovery.js';

const request = (path, value) => new Promise((resolve, reject) => {
  const sock = createConnection(path); let data = '';
  sock.on('connect', () => sock.end(JSON.stringify(value) + '\n'));
  sock.on('data', chunk => data += chunk); sock.on('end', () => resolve(JSON.parse(data)));
  sock.on('error', reject);
});

test('local recovery skips unknown turn and isolates sessions', async () => {
  const base = await mkdtemp(join(tmpdir(), 'chat-rec-')); const calls = [];
  const q = new ChatBatchQueue({waker: {}, run: async items => { calls.push(items[0].key); return calls.filter(x => x === items[0].key).length === 1 ? {ok:false} : {ok:true}; }});
  q.enqueue([{key:'private:a', text:'SECRET'}]); q.enqueue([{key:'private:a', text:'LATER'}]); q.enqueue([{key:'private:b', text:'OTHER'}]);
  await Promise.all([...q.chains.values()]);
  const server = await startChatRecovery(q, { directory: join(base, 'control') });
  try {
    const list = await request(server.path, {action:'list'});
    assert.equal(list.entries.length, 2); assert.doesNotMatch(JSON.stringify(list), /SECRET|private:|LATER|OTHER/);
    assert.equal((await request(server.path, {action:'resolve', id:list.entries[0].id, decision:'safe-to-retry'})).ok, false);
    assert.equal((await request(server.path, {action:'resolve', id:list.entries[0].id, decision:'discard'})).ok, true);
    assert.equal((await request(server.path, {action:'list'})).entries.length, 1);
    assert.equal(calls.filter(x=>x==='private:a').length + calls.filter(x=>x==='private:b').length, 3);
  } finally { await server.close(); await rm(base,{recursive:true,force:true}); }
});


test('rejects symlink and cleans up socket and directory on close', async () => {
  const base = await mkdtemp(join(tmpdir(), 'chat-sec-'));
  const dir = join(base, 'control');
  try {
    await symlink(base, dir);
    await assert.rejects(startChatRecovery({failed:new Set()}, {directory:dir}));
    assert.equal((await lstat(dir)).isSymbolicLink(), true);
    await rm(dir);
    const server = await startChatRecovery({failed:new Set()}, {directory:dir});
    assert.equal((await lstat(dir)).mode & 0o777, 0o700);
    await server.close();
    await assert.rejects(access(dir));
  } finally { await rm(base,{recursive:true,force:true}); }
});

test('different local uid cannot connect to owner socket', {skip: process.getuid() !== 0}, async () => {
  const base = await mkdtemp('/run/chat-recovery-test-');
  await chmod(base, 0o755);
  const server = await startChatRecovery({failed:new Set()}, {directory:join(base,'control')});
  try {
    const code = `const net=require('net');const s=net.connect(process.argv[1]);s.on('connect',()=>process.exit(1));s.on('error',()=>process.exit(0));`;
    const proc = spawn(process.execPath, ['-e', code, server.path], {uid:65534,gid:65534,stdio:'ignore'});
    const exit = await new Promise((resolve,reject) => {proc.on('error',reject);proc.on('exit',resolve)});
    assert.equal(exit, 0);
    assert.equal((await request(server.path,{action:'list'})).ok, true);
  } finally { await server.close(); await rm(base,{recursive:true,force:true}); }
});


test('old ID cannot resolve a new unknown turn during recovery', async () => {
  const base = await mkdtemp(join(tmpdir(), 'chat-race-')); let release;
  const gate = new Promise(r => {release = r}); let calls = 0;
  const q = new ChatBatchQueue({waker:{},run:async () => { calls++; if (calls === 2) await gate; return {ok:false}; }});
  q.enqueue([{key:'a'}]); q.enqueue([{key:'a'}]); await Promise.all([...q.chains.values()]);
  const server = await startChatRecovery(q,{directory:join(base,'control')});
  try {
    const id = (await request(server.path,{action:'list'})).entries[0].id;
    const first = request(server.path,{action:'resolve',id,decision:'discard'});
    while (calls < 2) await new Promise(r=>setTimeout(r,1));
    assert.equal((await request(server.path,{action:'resolve',id,decision:'discard'})).ok,false);
    release(); assert.equal((await first).ok,true);
    const next = (await request(server.path,{action:'list'})).entries;
    assert.equal(next.length,1); assert.notEqual(next[0].id,id);
  } finally { release(); await server.close(); await rm(base,{recursive:true,force:true}); }
});
