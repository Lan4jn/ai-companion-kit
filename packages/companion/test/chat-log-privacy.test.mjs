import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { WeChatTransport } from '../src/transport-wechat.js';
import { OneBot } from '../src/transport-onebot.js';
import { handleTurn } from '../src/index.js';
import { Humanizer } from '../src/humanize.js';
import path from 'node:path';

const source = name => fs.readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');

test('chat path source does not log message-derived values', () => {
  const checks = {
    'index.js': [/console\.(?:log|warn|error)\([^\n]*(?:msg\.text|prevMsg\.text|trapCheck\.match|outSafe\.why|r\.parts|\+ out\b|\+ img\b)/, /appendBridgeLog\([^\n]*msg\.(?:text|name)/],
    'transport-onebot.js': [/console\.(?:log|warn|error)\([^\n]*(?:String\(data\)|comment|message\.slice|\+ file\b|this\.wsUrl)/],
    'brain.js': [/console\.(?:log|warn|error)\([^\n]*(?:url\.slice|tc\.function\.arguments|e\.message)/],
    'growth.js': [/console\.(?:log|warn|error)\([^\n]*(?:theirWords|rules\.join)/],
    'topic-focus.js': [/console\.(?:log|warn|error)\([^\n]*lock\.topic/],
    'group-bridge.js': [/console\.(?:log|warn|error)\([^\n]*item\.text/],
  };
  for (const [name, patterns] of Object.entries(checks)) for (const pattern of patterns) assert.doesNotMatch(source(name), pattern, name);
});

test('wechat transport errors retain outcome without printing secret exception contents', async () => {
  const captured = []; const origError = console.error; const origFetch = globalThis.fetch;
  console.error = (...args) => captured.push(args.join(' '));
  globalThis.fetch = async () => { throw new Error('SYNTHETIC_CREDENTIAL_IMAGE_BODY'); };
  try {
    const bot=new WeChatTransport({apiUrl:'http://fixture.invalid'});
    assert.equal((await bot.send('wx:private:fixture', 'SYNTHETIC_MESSAGE')).ok, false);
    assert.equal((await bot.sendImage('wx:private:fixture', 'https://fixture.invalid/SYNTHETIC_IMAGE')).ok, false);
    assert.equal(captured.length, 2);
    assert.doesNotMatch(captured.join('\n'), /SYNTHETIC_/);
  } finally { console.error = origError; globalThis.fetch = origFetch; }
});

test('onebot image read failure keeps diagnostics without exposing path', async () => {
  const captured=[]; const orig=console.log; console.log=(...a)=>captured.push(a.join(' '));
  try { const bot=Object.create(OneBot.prototype); assert.equal(await bot.sendImage('private:fixture','/SYNTHETIC_PRIVATE_PATH'),null); assert.equal(captured.length,1); assert.doesNotMatch(captured[0],/SYNTHETIC_PRIVATE_PATH/); }
  finally {console.log=orig;}
});

 test('synthetic private, group and wechat turns send without logging text', async t => {
  const dir=fs.mkdtempSync(path.join(process.env.TMPDIR, 'chat-privacy-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const captured=[]; const oldLog=console.log, oldWarn=console.warn, oldError=console.error;
  console.log=console.warn=console.error=(...a)=>captured.push(a.join(' '));
  const sent=[];
  try {
    const deps={bot:{send:async(k,m)=>{sent.push([k,m]);return {ok:true}},setTyping:async()=>{}},brain:{reply:async()=>({text:'SYNTHETIC_REPLY'})},human:new Humanizer({enabled:false}),memory:{dir,touch:()=>{}},waker:{wake:()=>{}}};
    for(const [key,isGroup] of [['private:42',false],['group:42',true],['wx:private:42',false]]) {
      await handleTurn(deps,[{key,isGroup,groupId:isGroup?'42':'',userId:'42',name:'SYNTHETIC_NAME',text:'SYNTHETIC_INPUT'}],{ownerIds:[],dataDir:dir});
    }
    assert.equal(sent.length,3); assert.ok(sent.every(([,m])=>m.includes('SYNTHETIC_REPLY')));
    const bridge=fs.readFileSync(path.join(dir,'bridge.log'),'utf8');
    assert.match(bridge,/发出 1 条/); assert.match(captured.join('\n'),/发出 1 条/);
    assert.doesNotMatch(bridge+'\n'+captured.join('\n'),/SYNTHETIC_/);
  } finally {console.log=oldLog;console.warn=oldWarn;console.error=oldError;}
});
