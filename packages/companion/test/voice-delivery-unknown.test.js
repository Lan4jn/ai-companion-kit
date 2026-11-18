import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
register('./onebot-no-network-loader.js', import.meta.url);
const { OneBot } = await import('../src/transport-onebot.js');
const { default: WeChatTransport } = await import('../src/transport-wechat.js');
const { handleTurn } = await import('../src/index.js');
const { Humanizer } = await import('../src/humanize.js');

async function turn(t, bot, reply = {text: '合成回复', voiceB64: 'synthetic-audio', voiceText: '合成回复'}) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'voice-delivery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const effects = [];
  const deps = { bot, brain: { reply: async () => reply },
    human: new Humanizer({enabled: false}), memory: {dir, touch: () => effects.push('touch')},
    waker: {wake: () => effects.push('wake')} };
  const result = await handleTurn(deps, [{key:'private:42', userId:'42', name:'test', isGroup:false, text:'你好'}], {ownerIds:[], dataDir:dir});
  return {result, effects};
}

test('OneBot receipt lost after voice submission: unknown, no text fallback or success effects', async t => {
  const old = globalThis.fetch; t.after(() => {globalThis.fetch = old});
  const requests = [];
  globalThis.fetch = async (_url, options) => { requests.push(JSON.parse(options.body)); throw new Error('private-secret-audio'); };
  const bot = new OneBot({httpUrl:'http://synthetic', wsUrl:'ws://synthetic'});
  const {result, effects} = await turn(t, bot);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].message[0].type, 'record');
  assert.deepEqual(result, {ok:false, sent:0, outcome:'unknown', error:'VOICE_DELIVERY_FAILED'});
  assert.deepEqual(effects, []);
});

test('explicit OneBot rejection stops without text fallback', async t => {
  const old = globalThis.fetch; t.after(() => {globalThis.fetch = old});
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    const body = requests.length === 1 ? {status:'failed', retcode:100, message:'secret'} : {status:'ok', retcode:0};
    return {ok:true, text:async () => JSON.stringify(body)};
  };
  const bot = new OneBot({httpUrl:'http://synthetic', wsUrl:'ws://synthetic'});
  bot.setTyping = async () => {};
  const {result,effects} = await turn(t, bot);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].message[0].type, 'record');
  assert.deepEqual(result,{ok:false,sent:0,outcome:'permanent',error:'VOICE_DELIVERY_FAILED'});
  assert.deepEqual(effects, []);
});

test('unclassified, partial, and thrown voice results are unknown and private', async t => {
  for (const sendVoice of [async () => null, async () => ({ok:false, error:'secret'}), async () => ({ok:false, outcome:'permanent', sent:1, error:'secret'}), async () => ({ok:true, outcome:'unknown'}), async () => {throw Error('secret')}]) {
    let texts = 0;
    const {result, effects} = await turn(t, {sendVoice, send:async () => {texts++; return {ok:true}}, setTyping:async () => {}});
    assert.deepEqual(result, {ok:false, sent:0, outcome:'unknown', error:'VOICE_DELIVERY_FAILED'});
    assert.equal(texts, 0); assert.deepEqual(effects, []);
  }
});

test('confirmed voice success suppresses text fallback', async t => {
  let texts = 0;
  const bot = {sendVoice: async () => ({ok:true}), send: async () => {texts++;}, setTyping: async () => {}};
  const {effects} = await turn(t, bot);
  assert.equal(texts, 0);
  assert.deepEqual(effects, ['wake', 'touch']);
});

test('voice transport error details never appear in warnings', async t => {
  const original = console.warn; const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const {result,effects} = await turn(t, {sendVoice:async () => ({ok:false, outcome:'unknown', error:'private-secret'}), setTyping:async () => {}});
    assert.equal(result.error,'VOICE_DELIVERY_FAILED');
    assert.deepEqual(effects,[]);
    assert.ok(!warnings.join(' ').includes('private-secret'));
  } finally { console.warn = original; }
});

test('WeChat unsupported voice is explicitly not sent and no fallback is attempted', async t => {
  const bot = new WeChatTransport({});
  const result = await bot.sendVoice('private:42', 'synthetic');
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'permanent');
  let sent = 0;
  bot.send = async (_key, text) => { sent++; assert.equal(text, '合成回复'); return {ok:true}; };
  const run = await turn(t, bot);
  assert.equal(sent, 0);
  assert.deepEqual(run.result,{ok:false,sent:0,outcome:'permanent',error:'VOICE_DELIVERY_FAILED'});
  assert.deepEqual(run.effects, []);
});


test('multi-part voice stops after unknown delivery without replaying text', async t => {
  const sent = [], texts = [];
  const bot = { sendVoice: async (_key, b64) => { sent.push(b64); return sent.length === 2 ? {ok:false, outcome:'unknown'} : {ok:true}; }, send: async (_k, text) => {texts.push(text);return {ok:true}}, setTyping:async()=>{} };
  const reply = {text:'正文', voiceB64:'a', voiceText:'甲乙丙', voiceChunks:[{base64:'a',spokenText:'甲'},{base64:'b',spokenText:'乙'},{base64:'c',spokenText:'丙'}]};
  const {result,effects} = await turn(t,bot,reply);
  assert.deepEqual(sent,['a','b']); assert.deepEqual(texts,[]); assert.equal(result.outcome,'unknown'); assert.deepEqual(effects,[]);
});


test('missing chunk text blocks delivery before partial rejection can occur', async t => {
  const sent = [], texts = [];
  const bot = { sendVoice: async (_key, b64) => { sent.push(b64); return b64 === 'b' ? {ok:false,outcome:'permanent',sent:0} : {ok:true}; }, send: async (_key, text) => { texts.push(text); return {ok:true}; }, setTyping:async()=>{} };
  const reply = {text:'正文',voiceB64:'a',voiceText:'甲乙丙',voiceChunks:[{base64:'a',spokenText:'甲'},{base64:'b',spokenText:'乙'},{base64:'c'}]};
  const {result,effects} = await turn(t,bot,reply);
  assert.deepEqual(sent, []); assert.deepEqual(texts, []); assert.deepEqual(effects, []);
  assert.equal(result.error, 'VOICE_LENGTH_UNVERIFIED');
});

test('incomplete chunk metadata rejects voice before any send despite a claimed full transcript', async t => {
  const sent = [], texts = [];
  const bot = {sendVoice: async (_k,b) => {sent.push(b);return {ok:false,outcome:'permanent',sent:0}},send:async (_k,s)=>{texts.push(s);return {ok:true}},setTyping:async()=>{}};
  const reply = {text:'正文',voiceB64:'a',voiceText:'甲乙丙',voiceChunks:[{base64:'a',spokenText:'甲'},{base64:'b'}]};
  const {result,effects} = await turn(t,bot,reply);
  assert.equal(result.error, 'VOICE_LENGTH_UNVERIFIED');
  assert.deepEqual(sent, []); assert.deepEqual(texts, []); assert.deepEqual(effects, []);
});

test('voice length and transcript verification fail closed before transport', async t => {
  for (const reply of [
    {text:'短',voiceB64:'a'},
    {text:'短',voiceB64:'a',voiceText:'长'.repeat(51)},
    {text:'短',voiceB64:'a',voiceText:'甲乙',voiceChunks:[{base64:'a',spokenText:'甲'}]},
    {text:'短',voiceB64:'a',voiceText:'甲乙',voiceChunks:[{base64:'a',spokenText:'甲'},{base64:'b'}]},
  ]) {
    let calls = 0;
    const {result,effects} = await turn(t,{sendVoice:async()=>{calls++;return {ok:true}},send:async()=>{calls++;return {ok:true}},setTyping:async()=>{}},reply);
    assert.equal(result.error,reply.voiceText?.length > 50 ? 'TURN_LIMIT' : 'VOICE_LENGTH_UNVERIFIED'); assert.equal(calls,0); assert.deepEqual(effects,[]);
  }
});

test('verified 50-code-point voice is delivered normally', async t => {
  const sent=[];
  const {result,effects} = await turn(t,{sendVoice:async (_k,b)=>{sent.push(b);return {ok:true}},send:async()=>{throw Error('unexpected text')},setTyping:async()=>{}},
    {text:'短',voiceB64:'a',voiceText:'鱼'.repeat(50)});
  assert.deepEqual(sent,['a']); assert.notEqual(result?.ok,false); assert.deepEqual(effects,['wake','touch']);
});

test('multi-part success sends in order, rejection stops without text fallback', async t => {
  for (const reject of [false,true]) {
    const sent=[], texts=[];
    const bot={sendVoice:async (_k,b)=>{sent.push(b); return reject && b==='b' ? {ok:false,outcome:'permanent',sent:0} : {ok:true}},send:async (_k,s)=>{texts.push(s);return {ok:true}},setTyping:async()=>{}};
    const reply={text:'正文',voiceB64:'a',voiceText:'甲乙丙',voiceChunks:[{base64:'a',spokenText:'甲'},{base64:'b',spokenText:'乙'},{base64:'c',spokenText:'丙'}]};
    const {result,effects} = await turn(t,bot,reply);
    assert.deepEqual(sent,reject?['a','b']:['a','b','c']);
    assert.deepEqual(texts,[]);
    if (reject) { assert.deepEqual(result,{ok:false,sent:1,outcome:'permanent',error:'VOICE_DELIVERY_FAILED'}); assert.deepEqual(effects,[]); }
  }
});
