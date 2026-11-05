/**
 * 火山引擎余额查询
 *
 * 为什么绕这么一圈：ark 的 API key 只能调模型，查余额必须走
 * billing.volcengineapi.com 的 QueryBalanceAcct，而它要 AK/SK + V4 签名。
 * 这套签名的几个坑（kDate 的 "VOLC" 前缀、canonical headers 的顺序）
 * 在 Node 里手写对不上，直接调官方 Python SDK 最省事——已经验证过能通。
 *
 * 凭据在 /root/AccessKey.txt，格式 `AccessKeyId: xxx` / `SecretAccessKey: xxx`。
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'scripts', 'volc_balance.py');
const PYTHON = '/usr/bin/python3';

/** 查一次余额；失败返回 null（绝不抛，别让查余额把生图带崩） */
export function queryBalance({ timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    execFile(PYTHON, [SCRIPT], { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        console.log('[Billing] 查询失败：' + (stderr || err.message).slice(0, 120));
        return resolve(null);
      }
      try {
        const d = JSON.parse(String(stdout).trim().split('\n').pop());
        if (d.error) {
          console.log(`[Billing] ${d.error}：${d.detail || ''}`);
          return resolve(null);
        }
        resolve({ ...d, at: Date.now() });
      } catch (e) {
        console.log('[Billing] 解析失败：' + String(stdout).slice(0, 100));
        resolve(null);
      }
    });
  });
}

/** 带缓存：生图前调它，5 分钟内不重复打接口 */
let cache = { value: null, at: 0 };
const CACHE_MS = 5 * 60 * 1000;

export async function getBalanceCached({ force = false, ttlMs = CACHE_MS } = {}) {
  if (!force && cache.value && Date.now() - cache.at < ttlMs) return cache.value;
  const v = await queryBalance();
  // 查失败不覆盖旧值，免得网络抖一下就误判成没钱
  if (v) cache = { value: v, at: Date.now() };
  return cache.value;
}
