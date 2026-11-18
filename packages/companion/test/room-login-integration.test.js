import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { startVirtualRoomServer } from '../src/virtual-room.js';

test('local page blocks legacy QR, cross-site start and DNS rebinding', async () => {
  const dir=fs.mkdtempSync(path.join('/root/.hermes/cache/scratch/','room-login-test-'));
  const room=startVirtualRoomServer({port:0,host:'127.0.0.1',dataDir:dir});
  const addr=await room.ready; const base=`http://127.0.0.1:${addr.port}`;
  try {
    assert.equal((await fetch(base+'/login')).status,200);
    assert.equal((await fetch(base+'/api/account/bili/status').then(r=>r.json())).state,'offline');
    assert.equal((await fetch(base+'/api/account/douyin/status').then(r=>r.json())).state,'offline');
    for(const p of ['/api/douyin/status','/api/douyin/qr.png','/api/douyin/sms','/room_assets/douyin_qr_live.png','/room_assets/%64ouyin_qr_live.png']) assert.equal((await fetch(base+p)).status,404);
    assert.equal((await fetch(base+'/api/account/bili/start',{method:'POST',headers:{origin:'http://evil.test'}})).status,403);
    const rebinding = await new Promise((resolve,reject)=>http.get(base+'/api/account/bili/qr',{headers:{host:'evil.test'}},r=>{r.resume();resolve(r.statusCode)}).on('error',reject));
    assert.equal(rebinding,403);
  } finally {await room.stop();fs.rmSync(dir,{recursive:true,force:true});}
});
