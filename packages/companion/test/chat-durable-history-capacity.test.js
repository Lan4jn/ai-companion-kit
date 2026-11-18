import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Memory} from '../src/memory.js';
import {createMemoryBrain} from '../src/memory-brain-adapter.js';

const scope={tenant:'companion',platform:'qq',type:'private',session:'private:123',user:'123'};
const makeStore=(directory,extra={})=>createMemoryBrain({enabled:true,backend:'sqlite-fts',directory,authorize:async()=>true,recoveryAuthorization:async()=>true,...extra});
const turn=(id,extra={})=>({where:scope.session,who:scope.user,text:'hello',reply:'world',evidence:[`onebot-message:${id}`],scope,...extra});

test('scoped capacity refuses new turns while retaining retry and tombstone credentials across restart', async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'durable-capacity-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const directory=path.join(dir,'memory-brain-scoped'); const m=new Memory({dir});
 let store=makeStore(directory,{maxChatHistoryTurns:1});
 assert.equal(await m.logDurableTurn('a',turn(1,{store})),'inserted');
 await assert.rejects(m.logDurableTurn('b',turn(2,{store})));
 store=makeStore(directory,{maxChatHistoryTurns:1});
 assert.equal(await m.logDurableTurn('a',turn(1,{store})),'duplicate');
 assert.deepEqual((await store.chatHistory(scope)).map(x=>x.turnId),['a']);
 await store.forget(scope,{source:'qq-private-message',evidence:'onebot-message:1'});
 assert.equal(await m.logDurableTurn('a',turn(1,{store})),'forgotten');
 await assert.rejects(m.logDurableTurn('b',turn(2,{store})));
 assert.deepEqual(await store.chatHistory(scope),[]);
});

test('concurrent writers cannot exceed scoped history capacity', async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'durable-race-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const directory=path.join(dir,'memory-brain-scoped'); const m=new Memory({dir});
 const first=makeStore(directory,{maxChatHistoryTurns:1}), second=makeStore(directory,{maxChatHistoryTurns:1});
 const results=await Promise.allSettled([m.logDurableTurn('a',turn(1,{store:first})),m.logDurableTurn('b',turn(2,{store:second}))]);
 assert.equal(results.filter(r=>r.status==='fulfilled' && r.value==='inserted').length,1);
 assert.equal(results.filter(r=>r.status==='rejected').length,1);
 assert.equal((await first.chatHistory(scope)).length,1);
});

test('unknown cross-backend ledger fails closed without modification', async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'durable-unknown-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const directory=path.join(dir,'memory-brain-scoped'); fs.mkdirSync(directory,{mode:0o700});
 const hash=createHash('sha256').update(JSON.stringify([scope,'qq-private-message'])).digest('hex');
 const unknown=path.join(directory,`${hash}.sqlite3`);
 const m=new Memory({dir}), store=makeStore(directory);
 assert.equal(await m.logDurableTurn('a',turn(1,{store})),'inserted');
 fs.writeFileSync(unknown,'unknown',{mode:0o600});
 const before=fs.readFileSync(unknown);
 await assert.rejects(m.logDurableTurn('b',turn(2,{store})));
 await assert.rejects(store.chatHistory(scope));
 assert.deepEqual(fs.readFileSync(unknown),before);
});

test('oversized history is rejected before creating scoped storage', async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'durable-large-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const directory=path.join(dir,'memory-brain-scoped'); const m=new Memory({dir}),store=makeStore(directory);
 await assert.rejects(m.logDurableTurn('a',turn(1,{store,text:'x'.repeat(1024*1024)})),/invalid chat history/);
 assert.equal(fs.existsSync(directory),false);
});

 test('sqlite reservation excludes competing writers and commits idempotently', async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'reserve-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const first=makeStore(path.join(dir,'db'),{maxChatHistoryTurns:1}), second=makeStore(path.join(dir,'db'),{maxChatHistoryTurns:1});
 const a={turnId:'a',events:['onebot-message:1'],text:'hello',reply:'world'};
 assert.equal(await first.reserveChatHistory(scope,a),'reserved');
 await assert.rejects(second.commitChatHistory(scope,{...a,turnId:'b',events:['onebot-message:2']}));
 assert.equal(await second.reserveChatHistory(scope,a),'reserved');
 assert.equal(await second.commitChatHistory(scope,a),'inserted');
 assert.equal(await first.commitChatHistory(scope,a),'duplicate');
 });

test('reservation survives worker exit and forget prevents resurrection', async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'reserve-crash-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const directory=path.join(dir,'db'), a={turnId:'dead',events:['onebot-message:9'],text:'synthetic',reply:'reply'};
 const first=makeStore(directory,{maxChatHistoryTurns:1});
 assert.equal(await first.reserveChatHistory(scope,a),'reserved');
 const restarted=makeStore(directory,{maxChatHistoryTurns:1});
 await assert.rejects(restarted.reserveChatHistory(scope,{...a,turnId:'other'}));
 await restarted.forget(scope,{source:'qq-private-message',evidence:'onebot-message:9'});
 await assert.rejects(restarted.reserveChatHistory(scope,a));
 assert.equal(await restarted.commitChatHistory(scope,a),'forgotten');
 assert.deepEqual(await restarted.chatHistory(scope),[]);
});

test('concurrent reservations admit only one scoped turn', async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'reserve-race-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const directory=path.join(dir,'db'), first=makeStore(directory,{maxChatHistoryTurns:1}), second=makeStore(directory,{maxChatHistoryTurns:1});
 const results=await Promise.allSettled([first.reserveChatHistory(scope,{turnId:'a',events:['onebot-message:1'],text:'a',reply:'reply'}),second.reserveChatHistory(scope,{turnId:'b',events:['onebot-message:2'],text:'b',reply:'reply'})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(results.filter(r=>r.status==='rejected').length,1);
});
