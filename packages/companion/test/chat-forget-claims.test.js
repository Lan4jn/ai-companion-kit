import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleTurn } from '../src/index.js';
import { Humanizer } from '../src/humanize.js';

test('真实聊天入口不把模型的虚假遗忘回执或语音发出去，普通闲聊不受影响', async t => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'forget-chat-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  let response = {text:'好，我已经把那段记忆删除了', voiceB64:'fake', voiceText:'我已经忘记了'};
  const sent = [], voices = [];
  const deps = {bot:{send:async (_key, text) => {sent.push(text); return {ok:true};}, sendVoice:async (_key, voice)=>{voices.push(voice); return {ok:true};}, setTyping:async()=>{}}, brain:{reply:async()=>response}, human:new Humanizer({enabled:false}), memory:{dir,touch(){}}, waker:{wake(){}}};
  const item = {key:'private:42',userId:'42',name:'测试',isGroup:false,text:'你还记得吗'};
  const run = () => handleTurn(deps,[item],{ownerIds:[],dataDir:dir});
  await run();
  assert.equal(voices.length,0);
  assert.match(sent.join(''),/没有.*(?:遗忘|删除)|无法.*(?:遗忘|删除)/);
  sent.length=0; response={text:'我忘记带伞了，今天下雨呢'};
  await run(); assert.equal(sent.join(''),'我忘记带伞了，今天下雨呢');
  sent.length=0; item.text='请把那段记忆删除'; response={text:'已删除'};
  await run(); assert.match(sent.join(''),/没有.*入口.*没有删除/);
});
