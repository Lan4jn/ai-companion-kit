import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

// Run the actual onMessage and shutdown callback bodies with synthetic dependencies.
test('real SIGTERM drains accepted batches and rejects new messages', { timeout: 10000 }, async () => {
  const index = new URL('../src/index.js', import.meta.url).href;
  const wake = new URL('../src/wake.js', import.meta.url).href;
  const queue = new URL('../src/chat-batch-queue.js', import.meta.url).href;
  const source = `
    import fs from 'node:fs';
    import { setupProductionFanqie } from ${JSON.stringify(index)};
    import { Waker } from ${JSON.stringify(wake)};
    import { ChatBatchQueue } from ${JSON.stringify(queue)};
    const source = fs.readFileSync(new URL(${JSON.stringify(index)}), 'utf8');
    const start = source.indexOf('    onMessage: (msg) => {');
    const end = source.indexOf('\\n    },\\n  });', start);
    const body = source.slice(start + '    onMessage: (msg) => {'.length, end);
    const bs = source.indexOf('    beforeStop() {', end);
    const be = source.indexOf('\\n    },\\n    stopOthers()', bs);
    const stopBody = source.slice(bs + '    beforeStop() {'.length, be);
    if (start < 0 || end < 0 || bs < 0 || be < 0) throw Error('production bodies not found');
    const waker = new Waker({}); const directPendingBatches = new Map();
    const activeFollowupWindows = new Map(); let shuttingDown = false;
    const cfg = { ownerIds: [], wake: { privateWindowMs: 60000 }, dataDir: '/nonexistent' };
    const bot = { stopReceiving() {} }; const noop = () => {};
    const rel = {observe: noop, verdict: () => 'ok'};
    const respectGuard = {handleIncoming: () => ({blocked:false})};
    const delivered=[];
    const batchQueue = new ChatBatchQueue({waker,onFlush:key=>directPendingBatches.delete(key),run:async items=>{await new Promise(r=>setTimeout(r,30)); delivered.push(...items.map(m=>m.text)); return {ok:true};}});
    const pending=batchQueue.pending;
    const callback = new Function('msg','waker','pending','directPendingBatches','activeFollowupWindows','shuttingDown','cfg','bot','rel','respectGuard','applyVirtueText','path','appendBridgeLog','batchQueue',body);
    const send = (text) => callback({key:'private:synthetic',userId:'synthetic',name:'Synthetic',isGroup:false,text},waker,pending,directPendingBatches,activeFollowupWindows,shuttingDown,cfg,bot,rel,respectGuard,noop,{join:()=>''},noop,batchQueue);
    for (let i=0; i<7; i++) send('message-'+i);
    setupProductionFanqie({cfg:{}, start:()=>null, beforeStop() {
      new Function('bot','batchQueue','durableChat',stopBody.replace('shuttingDown = true;', ''))(bot,batchQueue,null);
      shuttingDown=true; send('too-late');
    }, async drain() { await batchQueue.drain(); console.log('DELIVERED:'+JSON.stringify(delivered)); }});
    console.log('READY');
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', c => { out += c; if (out.includes('READY') && !child.killed) child.kill('SIGTERM'); });
  child.stderr.on('data', c => { err += c; });
  try {
    const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({code, signal})); });
    assert.deepEqual(result, {code:0, signal:null}, err);
    const found = out.match(/DELIVERED:(\[[^\n]*\])/);
    assert.ok(found, out + err);
    assert.deepEqual(JSON.parse(found[1]), Array.from({length:7}, (_, i) => 'message-'+i));
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
});
