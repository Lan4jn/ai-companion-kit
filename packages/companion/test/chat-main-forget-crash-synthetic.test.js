import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fork} from 'node:child_process';
import {initializeManagedStore,createManagedMemoryBrain} from '../src/memory-brain-trust.js';
import {EncryptedChatJournal} from '../src/chat-durable-journal-candidate.js';

const worker=new URL('./fixtures/chat-main-forget-crash-worker.js',import.meta.url);
const scope={tenant:'companion',platform:'qq',type:'private',session:'private:123',user:'123'};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(f){for(let i=0;i<500;i++){if(f())return;await delay(10);}throw Error('fixture timeout');}
function setup(t){
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'main-forget-crash-'));fs.mkdirSync(path.join(dir,'journal'),{mode:0o700});
 fs.writeFileSync(path.join(dir,'key'),Buffer.alloc(32,7),{mode:0o600});fs.writeFileSync(path.join(dir,'role'),'synthetic role');
 const directory=path.join(dir,'store');initializeManagedStore(directory);
 const store=createManagedMemoryBrain({backend:'sqlite-fts',directory,scope,sources:['qq-private-message'],trustedProcess:true});
 let children=[];t.after(async()=>{for(const c of children)if(c.exitCode===null&&c.signalCode===null){c.kill('SIGKILL');await new Promise(r=>c.once('exit',r));}fs.rmSync(dir,{recursive:true,force:true});});
 const launch=(env={})=>{const c=fork(worker,[dir],{stdio:['ignore','ignore','pipe','ipc'],env:{...process.env,...env}});let errors='';c.stderr.on('data',x=>errors+=x);const events=[];c.on('message',x=>events.push(x));children.push(c);return {c,events,errors:()=>errors};};
 return {dir,store,launch};
}
const forget=store=>store.forget(scope,{source:'qq-private-message',evidence:'onebot-message:456'});

test('real main entry: cross-process forget waits for reserved send and blocks later bubbles',async t=>{
 const {store,launch}=setup(t),{c,events,errors}=launch();await wait(()=>events.some(x=>x.type==='connected'));c.send('input');await wait(()=>events.filter(x=>x.type==='send').length===1);c.send('ack');await wait(()=>events.filter(x=>x.type==='send').length===2);
 assert.deepEqual(events.filter(x=>x.type==='send').map(x=>x.message),['一','二']);
 let done=false;const task=forget(store).then(()=>{done=true;});await delay(200);assert.equal(done,false,'forget must wait for in-flight reserved send');
 c.send('ack');await wait(()=>done || events.filter(x=>x.type==='send').length>2);
 // flock has no fairness guarantee: acknowledge any already-started bubble so forget can acquire.
 let acknowledged=2;for(let i=0;!done && i<500;i++){const n=events.filter(x=>x.type==='send').length;if(n>acknowledged){c.send('ack');acknowledged=n;}await delay(10);}assert.ok(done,'forget did not finish');
 await task;const atForget=events.filter(x=>x.type==='send').length;await delay(500);assert.equal(events.filter(x=>x.type==='send').length,atForget,errors());
 assert.ok(atForget>=1&&atForget<=3);assert.deepEqual(await store.chatHistory(scope),[]);
 c.send('stop');await new Promise(r=>c.once('exit',r));
});

test('real main entry: SIGKILL during first uncertain bubble, forget and restart never resends',async t=>{
 const {dir,store,launch}=setup(t); await store.commitChatHistory(scope,{turnId:'previous',events:['onebot-message:1'],text:'old private marker',reply:'old answer'}); const a=launch();await wait(()=>a.events.some(x=>x.type==='connected'));a.c.send('input');await wait(()=>a.events.some(x=>x.type==='send'));
 a.c.kill('SIGKILL');await new Promise(r=>a.c.once('exit',r));await forget(store);await store.forget(scope,{source:'qq-private-message',evidence:'onebot-message:1'});
 fs.rmdirSync(path.join(dir,'journal','.journal.lock'));const j=new EncryptedChatJournal({directory:path.join(dir,'journal'),key:Buffer.alloc(32,7)});assert.equal(j.rows[0].state,'unknown');assert.deepEqual(j.rows[0].segments,['一','二','三']);j.close();
 const b=launch();await wait(()=>b.events.some(x=>x.type==='connected'));await delay(500);assert.equal(b.events.filter(x=>x.type==='send').length,0,b.errors());assert.deepEqual(await store.chatHistory(scope),[]);b.c.send('stop');await new Promise(r=>b.c.once('exit',r));
});

// New journal records retain only keyed dependency fingerprints, not old text.
test('forgotten generation provenance blocks send without persisting historical plaintext',async t=>{
 const {dir,store,launch}=setup(t);
 await store.commitChatHistory(scope,{turnId:'old-turn',events:['onebot-message:1'],text:'synthetic secret',reply:'synthetic answer'});
 const a=launch({HOLD_MODEL:'1'});await wait(()=>a.events.some(x=>x.type==='connected'));a.c.send('input');await wait(()=>a.events.some(x=>x.type==='model'));
 assert.ok(JSON.stringify(a.events.find(x=>x.type==='model').payload).includes('synthetic secret'));
 await store.forget(scope,{source:'qq-private-message',evidence:'onebot-message:1'});a.c.send('release-model');await delay(700);assert.equal(a.events.filter(x=>x.type==='send').length,0);a.c.send('stop');await new Promise(r=>a.c.once('exit',r));
 const j=new EncryptedChatJournal({directory:path.join(dir,'journal'),key:Buffer.alloc(32,7)});try {assert.equal(j.rows[0].state,'ready');assert.doesNotMatch(JSON.stringify(j.rows),/synthetic secret|synthetic answer/);assert.ok(j.rows[0].outputTags.length);}finally{j.close();}
});
