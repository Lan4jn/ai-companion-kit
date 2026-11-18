import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { OneBot } from '../src/transport-onebot.js';

const until = async (fn, timeout = 2000) => { const end = Date.now()+timeout; while (!fn()) { if (Date.now()>end) throw Error('timed out'); await new Promise(r=>setTimeout(r,10)); } };

test('heartbeat account offline is visible without confusing an open bridge for QQ online', async () => {
  const server = new WebSocketServer({port:0, host:'127.0.0.1'});
  await new Promise(r=>server.once('listening',r));
  let peer; server.on('connection', ws=>{peer=ws;});
  const bot = new OneBot({wsUrl:`ws://127.0.0.1:${server.address().port}`,httpUrl:''});
  try {
    await until(()=>peer && bot.connected);
    assert.deepEqual(bot.connectionStatus(), {alive:true, account:'unknown'});
    peer.send(JSON.stringify({post_type:'meta_event',meta_event_type:'heartbeat',status:{online:false,good:false}}));
    await until(()=>bot.connectionStatus().account==='offline');
    assert.deepEqual(bot.connectionStatus(), {alive:true, account:'offline'});
    peer.send(JSON.stringify({post_type:'meta_event',meta_event_type:'heartbeat',status:{online:true,good:true}}));
    await until(()=>bot.connectionStatus().account==='online');
    bot.accountStatusUntil = Date.now() - 1;
    assert.equal(bot.connectionStatus().account, 'unknown', 'stale heartbeat must not claim online');
    peer.terminate();
    await until(()=>!bot.connected);
    assert.deepEqual(bot.connectionStatus(), {alive:false, account:'unknown'});
    await until(()=>bot.connected, 7000);
    assert.deepEqual(bot.connectionStatus(), {alive:true, account:'unknown'}, 'reconnect cannot reuse previous account status');
  } finally { bot.close(); for(const ws of server.clients) ws.terminate(); await new Promise(r=>server.close(r)); }
});
