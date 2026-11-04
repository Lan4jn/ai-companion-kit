#!/usr/bin/env node
/**
 * 虚拟居室单体/离线演示服务 (Virtual Room Offline Demo)
 *
 * 纯离线启动虚拟居室 Web App，不加载任何 QQ、Playwright 或平台通信协程。
 * 用法:
 *   node examples/room-demo.js
 *   node examples/room-demo.js --port 18889
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { startVirtualRoomServer } from '../src/virtual-room.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 提取命令行参数 --port
const args = process.argv.slice(2);
let port = 18889;
const portIdx = args.indexOf('--port');
if (portIdx !== -1 && args[portIdx + 1]) {
  const parsed = parseInt(args[portIdx + 1], 10);
  if (!Number.isNaN(parsed)) port = parsed;
}

// 使用临时空数据目录，防读取/污染真实生活日记
const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'virtual-room-demo-data-'));
const dummyDiary = path.join(tmpDataDir, 'diary.jsonl');
fs.writeFileSync(
  dummyDiary,
  JSON.stringify({
    t: Date.now() - 3600000,
    title: '居室自包含演示',
    thought: '小鱼的独立离线虚拟居室已启动，无需依赖任何第三方平台！',
  }) + '\n'
);

const room = startVirtualRoomServer({
  port,
  host: '127.0.0.1',
  dataDir: tmpDataDir,
});

async function shutdown() {
  console.log('\n正在停止居室演示服务...');
  try {
    await room.stop();
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
  } catch {}
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await room.ready;
console.log(`[Demo] 虚拟居室演示服务运行在 http://127.0.0.1:${port}/ (按 Ctrl+C 退出)`);
