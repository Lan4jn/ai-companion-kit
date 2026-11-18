// Durable at-most-once submission ledger. Never delete entries automatically.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function reserveComment({account, aid, root = '', message, ledgerDir}) {
  if (!/^\d+$/.test(String(account || '')) || !/^\d+$/.test(String(aid || '')) || (root && !/^\d+$/.test(String(root)))) return {ok:false, code:'comment_identity_missing'};
  const dir = ledgerDir || process.env.BILI_COMMENT_LEDGER_DIR || path.join(process.env.HOME || '/root', '.bili-ai', 'comment-ledger');
  const target = {account:String(account), aid:String(aid), operation:root ? 'reply' : 'comment', root:String(root || '')};
  const key = crypto.createHash('sha256').update(JSON.stringify(target)).digest('hex');
  const file = path.join(dir, key + '.json');
  let fd;
  let creatingEntry = false;
  try {
    fs.mkdirSync(dir, {recursive:true, mode:0o700});
    // Persist directory creation as well as the new ledger entry.
    for (const d of [path.dirname(path.dirname(dir)), path.dirname(dir), dir]) {
      const dfd = fs.openSync(d, 'r'); try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
    }
    creatingEntry = true;
    fd = fs.openSync(file, 'wx', 0o600);
    creatingEntry = false;
    const record = {...target, status:'unknown', createdAt:new Date().toISOString(), messageSha256:crypto.createHash('sha256').update(message).digest('hex')};
    fs.writeFileSync(fd, JSON.stringify(record) + '\n');
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    const dfd = fs.openSync(dir, 'r'); try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
    return {ok:true};
  } catch (e) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    return {ok:false, code:creatingEntry && e.code === 'EEXIST' ? 'comment_already_reserved' : 'comment_ledger_unavailable'};
  }
}

export function accountFromHeaders(headers) {
  return (headers?.cookie || '').match(/(?:^|;\s*)DedeUserID=(\d+)(?:;|$)/)?.[1] || '';
}
