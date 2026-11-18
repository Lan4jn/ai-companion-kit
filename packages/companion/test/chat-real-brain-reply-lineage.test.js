import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {register} from 'node:module';
import {Memory} from '../src/memory.js';
import {Brain} from '../src/brain.js';
import {Role} from '../src/role.js';
import {Humanizer} from '../src/humanize.js';
import {handleTurn} from '../src/index.js';
import {OneBot} from '../src/transport-onebot.js';
import {initializeManagedStore, createManagedMemoryBrain} from '../src/memory-brain-trust.js';
register('./memory-brain-fake-ws-loader.js', import.meta.url);

test('real Brain propagates same-scope reply dependencies through forget barrier', async t => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'real-reply-lineage-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const scope = {tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'};
  const directory = path.join(dir,'memory-brain-scoped');
  initializeManagedStore(directory);
  const store = createManagedMemoryBrain({directory,scope,sources:['qq-private-message'],trustedProcess:true});
  const memory = new Memory({dir});
  const card = path.join(dir,'role.md'); fs.writeFileSync(card,'Synthetic static persona.');
  const brain = new Brain({apiKey:'fixture',baseUrl:'http://fixture',model:'fixture',role:new Role({cardPath:card}),memory,dataDir:dir,ownerIds:['1']});
  const requests = [];
  t.mock.method(globalThis,'fetch',async (_url,options) => {
    requests.push(JSON.parse(options.body));
    return {ok:true,text:async()=>JSON.stringify({choices:[{message:{content:`synthetic answer ${requests.length}`},finish_reason:'stop'}]})};
  });
  let resolve;
  const receiver = new OneBot({wsUrl:'ws://fixture',onMessage:m=>resolve(m)});
  receiver.api=async()=>({ok:false}); receiver.getMyGroupCard=async()=>'';
  while(!receiver.ws) await new Promise(r=>setTimeout(r,1));
  receiver.ws.emit('open');
  t.after(()=>receiver.close());
  const deps={brain,memory,bot:{send:async()=>({ok:true}),setTyping:async()=>{}},human:new Humanizer({enabled:false}),waker:{wake:()=>{}}};
  const cfg={ownerIds:['1'],dataDir:dir,memoryBrain:{enabled:true,trustedProcess:true,trustedScope:scope,authorizedSources:['qq-private-message']}};
  async function send(id,text) {
    const pending = new Promise(r=>resolve=r);
    receiver.ws.emit('message',JSON.stringify({post_type:'message',message_type:'private',user_id:1,message_id:id,message:[{type:'text',data:{text}}]}));
    await handleTurn(deps,[await pending],cfg);
  }
  await send(11,'first');
  const secondStart = requests.length;
  await send(12,'second');
  assert.ok(requests[secondStart].messages.some(m=>m.role==='assistant' && m.content==='synthetic answer 1'));
  await store.forget(scope,{source:'qq-private-message',evidence:'onebot-message:11'});
  const thirdStart = requests.length;
  await send(13,'third');
  assert.ok(!requests[thirdStart].messages.some(m=>m.role==='assistant' && /synthetic answer/.test(m.content)));
});
