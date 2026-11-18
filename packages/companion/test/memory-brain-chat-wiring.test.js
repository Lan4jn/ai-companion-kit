import test from 'node:test';
import assert from 'node:assert/strict';
import { Brain } from '../src/brain.js';
import { OneBot } from '../src/transport-onebot.js';
import { register } from 'node:module';
register('./memory-brain-fake-ws-loader.js', import.meta.url);

async function trustedMessage() {
 let resolveMessage;
 const received = new Promise(resolve => { resolveMessage = resolve; });
 const bot = new OneBot({wsUrl:'ws://fixture', onMessage:resolveMessage});
 bot.api=async()=>({ok:false});
 while (!bot.ws) await new Promise(resolve=>setTimeout(resolve,1));
 bot.ws.emit('open');
 bot.ws.emit('message',JSON.stringify({post_type:'message',message_type:'private',user_id:1,message_id:123,message:[{type:'text',data:{text:'苹果'}}]}));
 const event=await received;
 bot.close();
 return event;
}

test('chat memory augments recall, preserves evidence and falls back on failure', async t => {
 const requests=[];
 t.mock.method(globalThis,'fetch',async (_url,options)=>{requests.push(JSON.parse(options.body)); return {ok:true,text:async()=>JSON.stringify({choices:[{message:{content:'好'}}]})};});
 const scopes=[];
 const brain=new Brain({apiKey:'unused',role:{build:({situation})=>situation}, memory:{recallTurns:(_query,options)=>{scopes.push(options.where);return [{who:'甲',text:'旧对话',reply:'好'}];}},dataDir:process.env.TMPDIR});
 const qqEvent=await trustedMessage();
 const input={key:qqEvent.key,userId:qqEvent.userId,text:'苹果',qqEvent,record:false,tools:false};
 await brain.reply({...input, scopedMemoryRecall:async()=>[{text:'苹果记录',source:'chat',evidence:'ev1'}]});
 assert.match(JSON.stringify(requests[0].messages),/苹果记录/);
 assert.match(JSON.stringify(requests[0].messages),/ev1/);
 assert.match(JSON.stringify(requests[0].messages),/旧对话/);
 await brain.reply({...input,scopedMemoryRecall:async()=>{throw new Error('down')}});
 assert.match(JSON.stringify(requests[1].messages),/旧对话/);
 assert.deepEqual(scopes,['private:1','private:1']);
 await brain.reply({...input,qqEvent:{...qqEvent}});
 assert.doesNotMatch(JSON.stringify(requests[2].messages),/旧对话/);
 assert.deepEqual(scopes,['private:1','private:1']);
 await brain.reply({...input,key:'private:2',userId:'2'});
 assert.doesNotMatch(JSON.stringify(requests[3].messages),/旧对话/);
 assert.deepEqual(scopes,['private:1','private:1']);
});
