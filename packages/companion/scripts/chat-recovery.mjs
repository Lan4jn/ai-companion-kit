#!/usr/bin/env node
// Interactive only: opaque IDs and confirmations are never placed in argv.
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { join } from 'node:path';
import { defaultRecoveryDirectory } from '../src/chat-recovery.js';

if (!stdin.isTTY || !stdout.isTTY || process.argv.length !== 2) {
  console.error('请在本机交互终端运行，不接受命令行参数或管道输入。'); process.exit(1);
}
const path = join(defaultRecoveryDirectory(), 'control.sock');
const request = msg => new Promise((resolve, reject) => {
  const socket = createConnection(path); let data = '';
  socket.setTimeout(5000, () => socket.destroy(new Error('timeout')));
  socket.on('connect', () => socket.end(JSON.stringify(msg) + '\n'));
  socket.on('data', c => { data += c; if (data.length > 100000) socket.destroy(new Error('response too large')); });
  socket.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('invalid response')); } });
  socket.on('error', reject);
});
const rl = createInterface({input:stdin, output:stdout});
try {
  const list = await request({action:'list'});
  if (!list.ok || !list.entries.length) console.log('没有暂停的会话。');
  else {
    list.entries.forEach((entry, i) => console.log(`${i + 1}. 会话指纹 ${entry.sessionFingerprint} 开始处理时间 ${entry.attemptedAt ?? '未知'} 状态 ${entry.status}`));
    const n = Number(await rl.question('选择序号，或回车取消：'));
    const entry = list.entries[n - 1];
    if (Number.isInteger(n) && entry) {
      const choice = await rl.question('输入 delivered（确认已处理）或 discard（丢弃未知回合）；其他输入取消：');
      if (['delivered','discard'].includes(choice)) {
        const confirmation = await rl.question('确认跳过此未知回合并恢复后续消息？输入 YES：');
        if (confirmation === 'YES') console.log((await request({action:'resolve', id:entry.id, decision:choice})).ok ? '已接受恢复；后续回合仍在处理，可能再次暂停。' : '恢复失败或状态已变化。');
      }
    }
  }
} catch { console.error('无法连接本机恢复入口；请检查服务和运行用户。'); process.exitCode = 1; }
finally { rl.close(); }
