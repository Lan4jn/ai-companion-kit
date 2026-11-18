import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {createOneBotUnixSender} from '../src/chat-onebot-unix-sender.js';

test('private unix OneBot HTTP sends one segment without credentials and rejects replaced endpoint', async()=>{
 const root=fs.mkdtempSync(path.join(process.env.TMPDIR,'onebot-unix-')); const socket=path.join(root,'onebot.sock');
 let calls=0; const server=http.createServer((req,res)=>{calls++;assert.equal(req.url,'/send_private_msg');assert.equal(req.headers.authorization,undefined);let body='';req.on('data',x=>body+=x);req.on('end',()=>{assert.deepEqual(JSON.parse(body),{user_id:'123',message:[{type:'text',data:{text:'fixture'}}]});res.end(JSON.stringify({status:'ok',retcode:0}));});});
 try {
  await new Promise(r=>server.listen(socket,r));fs.chmodSync(socket,0o600);
  const bot=createOneBotUnixSender({socketPath:socket});
  assert.equal((await bot.send('private:123','fixture')).data.status,'ok');assert.equal(calls,1);
  fs.unlinkSync(socket);fs.writeFileSync(socket,'not a socket');
  await assert.rejects(bot.send('private:123','fixture'));assert.equal(calls,1);bot.close();
 } finally {await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});}
});
