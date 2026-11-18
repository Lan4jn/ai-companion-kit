import test from 'node:test';
import assert from 'node:assert/strict';
import {handleTurn} from '../src/index.js';
import {Humanizer} from '../src/humanize.js';
import {Brain} from '../src/brain.js';
import {prepareConciseReply} from '../src/chat-concise-delivery.js';

for (const isGroup of [false, true]) test(`QQ ${isGroup ? 'group' : 'private'}: rejected literal rewrite can be corrected`, async () => {
  const original = '这款设备保修2年，需保留购买凭证。购买凭证很重要，请妥善保存，售后办理时需要出示购买凭证，建议把纸质凭证放在安全的地方。';
  const attempts = [], sent = []; let reviews = 0, generated = 0;
  const brain = {
    reply: async () => { generated++; return {text: original}; },
    rewriteConciseDraft: async (_draft, feedback) => {
      attempts.push(feedback);
      return feedback === 'literals' ? '这款设备保修2年，售后需出示购买凭证；建议把纸质凭证妥善保存在安全的地方。' : '这款设备保修一年，售后需出示购买凭证；建议把纸质凭证妥善保存在安全的地方。';
    },
    verifyConciseDraft: async (_draft, candidate) => { reviews++; return candidate.includes('2年'); }
  };
  const memory={renderPerson:()=>'',renderRecent:()=>'',sessionTurns:()=>[],remember:()=>{},logTurn:()=>{},touch:()=>{}};
  const item={key:isGroup?'group:42':'private:342',isGroup,groupId:isGroup?'42':'',userId:'42',name:'fixture',text:'保修如何？',images:[],raw:{},isAtMe:true,isPoke:false,replyTo:null,messageId:'fixture',time:Date.now()};
  await handleTurn({bot:{send:async(k,m)=>{sent.push(m);return {ok:true}},setTyping:async()=>{},getMyGroupCard:async()=>''},brain,human:new Humanizer({enabled:false}),memory,waker:{wake:()=>{}}},[item],{ownerIds:[],dataDir:process.env.TMPDIR});
  assert.deepEqual(attempts,[undefined,'literals']);
  assert.equal(generated,1); assert.equal(reviews,1);
  assert.deepEqual(sent,['这款设备保修2年，售后需出示购买凭证；建议把纸质凭证妥善保存在安全的地方。']);
});

test('brain sends only fixed feedback with tools disabled', async t => {
  const brain = new Brain({apiKey:'fixture',baseUrl:'http://fixture.invalid',model:'fixture'});
  let payload;
  t.mock.method(globalThis,'fetch',async (_url, options) => { payload=JSON.parse(options.body); return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:'fixture'}}]})}; });
  await brain.rewriteConciseDraft('synthetic draft','literals');
  assert.equal(payload.tool_choice,'none');
  assert.match(payload.messages[0].content,/逐字保留/);
  await brain.rewriteConciseDraft('synthetic draft','unsafe user text');
  assert.doesNotMatch(payload.messages[0].content,/unsafe user text/);
});

test('retry failures and provider bodies never leak to logs or feedback', async () => {
  const secret = 'synthetic-secret-token-73';
  const feedbacks = [], logs = []; let calls = 0;
  const originalWarn = console.warn;
  console.warn = (...args) => logs.push(args.join(' '));
  try {
    const result = await prepareConciseReply('长'.repeat(51), async (_draft, feedback) => {
      feedbacks.push(feedback); calls++;
      throw Object.assign(new Error(secret), {conciseReason: secret, status: secret});
    }, async () => true);
    assert.equal(result.failed, true); assert.equal(calls, 5);
    assert.deepEqual(feedbacks, [undefined, 'rewrite', 'rewrite', 'rewrite', 'rewrite']);
    assert.doesNotMatch(JSON.stringify({logs, feedbacks, result}), /synthetic-secret-token-73/);
  } finally { console.warn = originalWarn; }
});

test('tool calls returned by a provider are rejected during rewrite and review', async t => {
  const brain = new Brain({apiKey:'fixture'}); let requests = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    requests++;
    const payload = JSON.parse(options.body);
    assert.equal(payload.tool_choice, 'none');
    return {ok:true, json:async()=>({choices:[{finish_reason:'stop', message:{content:'PASS', tool_calls:[{id:'synthetic'}]}}]})};
  });
  await assert.rejects(brain.rewriteConciseDraft('synthetic', 'literals'));
  await assert.rejects(brain.verifyConciseDraft('synthetic', 'candidate'));
  assert.equal(requests, 2);
});
