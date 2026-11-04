#!/usr/bin/env node
/**
 * 130 预览环境专用启动入口 (Room Character Preview Launcher)
 *
 * 部署于 192.168.31.130 (picoclaw-130) 的独立轻量预览服务：
 * - 绑定独立空闲端口 18889（不占用已有的 18888 生产服务）；
 * - 默认监听 0.0.0.0（支持内网 http://192.168.31.130:18889/ 访问）；
 * - 数据目录隔离：优先采用 systemd 提供的 STATE_DIRECTORY，或降级到临时目录，绝不读取 /root 下真实生活日记与 Cookie；
 * - 优雅退出：捕获 SIGINT / SIGTERM 并执行 room.stop() 清理 SSE 与连接。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { startVirtualRoomServer } from './src/virtual-room.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const host = process.env.HOST || '0.0.0.0';
const port = parseInt(process.env.PORT || '18889', 10);

// 数据目录优先使用 systemd StateDirectory (/var/lib/room-character-preview)
let dataDir = process.env.STATE_DIRECTORY;
if (!dataDir || !fs.existsSync(dataDir)) {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-preview-data-'));
}

// 确保隔离目录下有空的生活日记，避免读取真实数据
const previewDiaryPath = path.join(dataDir, 'diary.jsonl');
if (!fs.existsSync(previewDiaryPath)) {
  fs.writeFileSync(
    previewDiaryPath,
    JSON.stringify({
      t: Date.now(),
      title: '居室预览环境就绪',
      thought: '130 独立角色层预览服务已成功启动，运行于 18889 端口，完全与生产生活数据隔离。',
    }) + '\n'
  );
}

const room = startVirtualRoomServer({
  host,
  port,
  dataDir,
});

async function handleShutdown(signal) {
  console.log(`\n[Preview] 收到信号 ${signal}，正在优雅停止居室预览服务...`);
  try {
    await room.stop();
    console.log('[Preview] 居室预览服务已安全关闭');
  } catch (err) {
    console.error('[Preview] 停止服务时发生异常:', err);
  }
  process.exit(0);
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

await room.ready;
console.log(`[Preview] 居室角色预览服务已就绪: http://${host}:${port}/ (内网访问: http://192.168.31.130:${port}/)`);
console.log(`[Preview] 数据隔离目录: ${dataDir}`);
