import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareConciseReply, createConciseBudget} from '../src/chat-concise-delivery.js';
import {handleTurn} from '../src/index.js';
import {Humanizer} from '../src/humanize.js';
import {Brain} from '../src/brain.js';
import {createLocalDurableBrainGenerator} from '../src/chat-onebot-queue-bridge.js';

test('a shared turn budget caps two preparations at five and redacts failures', async () => {
  const budget = createConciseBudget(); let calls=0; const logs=[];
  const warn=console.warn; console.warn=(...args)=>logs.push(args.join(' '));
  try {
    const rewrite=async()=>{calls++; throw Error('secret model response body');};
    const opts={budget};
    assert.equal((await prepareConciseReply('私密正文'.repeat(30),rewrite,undefined,opts)).failed,true);
    assert.equal((await prepareConciseReply('另一份正文'.repeat(30),rewrite,undefined,opts)).failed,true);
    assert.equal(calls,5);
    assert.ok(logs.some(s=>s.includes('rewrite') && s.includes('5')));
    assert.doesNotMatch(logs.join('\n'),/secret|正文|model response/);
  } finally {console.warn=warn;}
});

test('fifth attempt succeeds and stops; next preparation shares remaining budget', async () => {
  const budget=createConciseBudget(); let calls=0;
  const rewrite=async()=> ++calls === 5 ? '短回复' : '';
  const result=await prepareConciseReply('长'.repeat(51),rewrite,async()=>true,{budget});
  assert.deepEqual(result.parts,['短回复']); assert.equal(calls,5);
  const next=await prepareConciseReply('另'.repeat(51),rewrite,async()=>true,{budget});
  assert.equal(next.failed,true); assert.equal(calls,5);
});

test('entry shares budget across successful long rewrite and later preparation', async () => {
  let rewrites=0, replies=0, verifies=0; const sent=[];
  const brain={reply:async()=>{replies++;return {text:'原'.repeat(80)}},rewriteConciseDraft:async()=>{rewrites++;return rewrites < 4 ? '' : '改'.repeat(60)},verifyConciseDraft:async()=>{verifies++;return true}};
  const memory={renderPerson:()=>'',renderRecent:()=>'',sessionTurns:()=>[],remember:()=>{},logTurn:()=>{},touch:()=>{}};
  const item={key:'private:342',isGroup:false,userId:'42',name:'fixture',text:'fixture',images:[],raw:{},isAtMe:true,isPoke:false,replyTo:null,messageId:'fixture',time:Date.now()};
  await handleTurn({bot:{send:async(_k,m)=>{sent.push(m);return {ok:true}},setTyping:async()=>{}},brain,human:new Humanizer({enabled:false}),memory,waker:{wake:()=>{}}},[item],{ownerIds:[],dataDir:process.env.TMPDIR});
  assert.equal(replies,1); assert.equal(rewrites,5); assert.equal(verifies,0); assert.equal(sent.length,0);
});

test('failure stage and reason logs are redacted', async t => {
 const logs=[]; t.mock.method(console,'warn',(...a)=>logs.push(a.join(' ')));
 const cases=[['empty',async()=>'',undefined],['format',async()=> '甲\n\n乙\n\n丙\n\n丁',undefined],['too_long',async()=> '甲'.repeat(1001),undefined],['literals',async()=> '改变数字3',undefined],['review_rejected',async()=> '短',async()=>false],['review_invalid',async()=> '短',async()=> 'secret'],['review_error',async()=> '短',async()=>{throw Error('secret')}]];
 for (const [stage,rewrite,verify] of cases) {
   const input=stage==='literals'?'数字2'.repeat(30):'私密正文'.repeat(20);
   await prepareConciseReply(input,rewrite,verify);
   assert.ok(logs.some(x=>x.includes(`stage=${stage} `)),stage);
 }
 assert.ok(logs.every(x=>/attempt=[1-5] elapsed_ms=\d+/.test(x) || /stage=exhausted$/.test(x)));
 assert.doesNotMatch(logs.join('\n'),/私密正文|secret|改变数字|数字2/);
});

test('durable generator exhausts five tool-free rewrites without retrying generation', async t => {
 let generated=0, rewrites=0;
 const brain=new Brain({apiKey:'fixture',model:'fixture',baseUrl:'https://example.invalid',ownerIds:['123'],role:{buildDurablePersona:()=> 'fixture'},memory:{}});
 brain.generateDurableTextCandidate=async()=>{generated++;return ['原'.repeat(80)];};
 brain.rewriteConciseDraft=async()=>{rewrites++;throw Error('secret');};
 t.mock.method(console,'warn',()=>{});
 const run=createLocalDurableBrainGenerator({brain,ownerId:'123',trustLocalCard:true});
 await assert.rejects(run([]), /concise failed/);
 assert.equal(generated,1); assert.equal(rewrites,5);
});

test('real brain emits only safe HTTP and invalid-review diagnostics', async t => {
 const logs=[]; t.mock.method(console,'warn',(...a)=>logs.push(a.join(' ')));
 const brain=new Brain({apiKey:'private-key',model:'fixture',baseUrl:'https://example.invalid',role:{},memory:{}});
 t.mock.method(globalThis,'fetch',async()=>({ok:false,status:429,json:async()=>{throw Error('secret body')}}));
 await prepareConciseReply('私密正文'.repeat(20),d=>brain.rewriteConciseDraft(d));
 assert.ok(logs.some(x=>x.includes('reason=http_status http_status=429')));
 globalThis.fetch.mock.mockImplementation(async()=>({ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:'secret response body'}}]})}));
 await prepareConciseReply('私密正文'.repeat(20),async()=> '短', (d,c)=>brain.verifyConciseDraft(d,c));
 assert.ok(logs.some(x=>x.includes('stage=review_error') && x.includes('reason=invalid_response')));
 assert.doesNotMatch(logs.join('\n'),/私密正文|private-key|secret/);
});
