import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {WebSocketServer} from 'ws';
import {createMainDurableTransport} from '../src/chat-main-durable.js';
import {OneBot,snapshotAuthenticatedOneBotPrivateMessage} from '../src/transport-onebot.js';

const wait = async f=>{for(let i=0;i<200;i++){if(f())return;await new Promise(r=>setTimeout(r,10));}throw Error('timeout');};
test('explicit loopback trust connects real parser and guarded owner sender',async()=>{
  const sent=[]; let peer, bot, message, drop=false;
 const server=http.createServer((req,res)=>{let data='';req.on('data',c=>data+=c);req.on('end',()=>{sent.push(JSON.parse(data));if(drop){req.socket.destroy();return;}res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({status:'ok',retcode:0}));});});
 const wss=new WebSocketServer({server});
 try {
  await new Promise(r=>server.listen(0,'127.0.0.1',r));wss.on('connection',s=>peer=s);
  const port=server.address().port,onebot={wsUrl:`ws://127.0.0.1:${port}`,httpUrl:`http://127.0.0.1:${port}`};
  const config={enabled:true,ownerId:'123',transport:{trustLoopbackOneBot:true,senderUrl:`http://127.0.0.1:${port}/`}};
  const transport=createMainDurableTransport({config,onebot,ownerIds:['123']});
  bot=new OneBot({...onebot,ingressAuthentication:transport.ingressAuthentication,onMessage:m=>message=m});
  await wait(()=>peer);peer.send(JSON.stringify({post_type:'message',message_type:'private',self_id:789,user_id:123,message_id:1,message:[{type:'text',data:{text:'fixture'}}]}));
  await wait(()=>message);assert.equal(snapshotAuthenticatedOneBotPrivateMessage(bot,message,'123').text,'fixture');
  assert.deepEqual(await transport.sender.send('private:999','hello'),{ok:false,outcome:'permanent'});
  assert.deepEqual(await transport.sender.send('private:123','[CQ:image,file=x]'),{ok:false,outcome:'permanent'});
  assert.equal((await transport.sender.send('private:123','safe reply')).ok,true);assert.equal(sent.filter(x=>x.message==='safe reply').length,1);
  drop=true;assert.deepEqual(await transport.sender.send('private:123','uncertain'),{ok:false,outcome:'unknown'});await new Promise(r=>setTimeout(r,50));assert.equal(sent.filter(x=>x.message==='uncertain').length,1);
  assert.throws(()=>createMainDurableTransport({config:{...config,transport:{...config.transport,trustLoopbackOneBot:false}},onebot,ownerIds:['123']}));
  assert.throws(()=>createMainDurableTransport({config,onebot:{...onebot,wsUrl:`ws://127.1:${port}`},ownerIds:['123']}));
  assert.throws(()=>createMainDurableTransport({config,onebot:{...onebot,wsUrl:`ws://localhost:${port}`},ownerIds:['123']}));
  assert.throws(()=>createMainDurableTransport({config:{...config,transport:{...config.transport,senderUrl:`http://192.0.2.1:${port}/`}},onebot,ownerIds:['123']}));
 } finally {bot?.close();wss.clients.forEach(s=>s.terminate());await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));}
});
