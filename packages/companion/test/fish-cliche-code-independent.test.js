import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Brain } from '../src/brain.js';
import { Humanizer } from '../src/humanize.js';
import { handleTurn } from '../src/index.js';
import { OneBot } from '../src/transport-onebot.js';
import { register } from 'node:module';
register('./memory-brain-fake-ws-loader.js', import.meta.url);

test('QQ technical answer preserves nested parentheses in fenced code', async t => {
  const answer = '计算结果是 5。\n```js\nconsole.log((2 + 3))\n```\n参考：https://example.com/doc';
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return { ok: true, text: async () => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: answer } }] }) };
  });
  const brain = new Brain({ apiKey: 'fixture', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', llmFallbacks: [] });
  const result = await brain.reply({ key: 'private:audit-code-parentheses', userId: '42', text: '解释这段代码', record: false });
  assert.equal(result.text, answer);
  assert.equal(requests, 1);
});

test('real OneBot entry preserves full technical answer', async t => {
  let receive; const got = new Promise(r => receive = r);
  const bot = new OneBot({wsUrl:'ws://fixture',onMessage:receive});
  bot.api=async()=>({ok:false}); bot.getMyGroupCard=async()=>''; t.after(()=>bot.close());
  while(!bot.ws) await new Promise(r=>setTimeout(r,5));
  bot.ws.emit('open');
  bot.ws.emit('message',JSON.stringify({post_type:'message',message_type:'private',user_id:42,self_id:99,message_id:11,message:[{type:'text',data:{text:'解释代码'}}],sender:{nickname:'fixture'}}));
  const item=await got, sent=[]; bot.send=async(_k,m)=>{sent.push(m);return {ok:true,data:{message_id:123}}}; bot.setTyping=async()=>{};
  const answer='结果5\n```js\nconsole.log((2+3))\n```\nhttps://e.co'; let n=0;
  t.mock.method(globalThis,'fetch',async()=>{n++;return {ok:true,text:async()=>JSON.stringify({choices:[{finish_reason:'stop',message:{content:answer}}]})}});
  const memory={dir:process.env.TMPDIR,renderPerson:()=>'',renderRecent:()=>'',sessionTurns:()=>[],remember:()=>{},logTurn:()=>{},touch:()=>{}};
  const brain=new Brain({apiKey:'fixture',baseUrl:'https://fixture.invalid/v1',model:'fixture',llmFallbacks:[]});
  const human=new Humanizer({enabled:false});
  await handleTurn({bot,brain,human,memory,waker:{wake:()=>{}}},[item],{ownerIds:[],dataDir:process.env.TMPDIR});
  assert.deepEqual(sent,[answer]); assert.equal(n,1);
});
