import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Brain} from '../src/brain.js';
import {handleTurn} from '../src/index.js';
import {EncryptedChatJournal} from '../src/chat-durable-journal-candidate.js';

test('opt-in real Brain tool loop persists before execution and replays without effects', async t => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'brain-effects-'));
 const journal=new EncryptedChatJournal({directory:dir,key:Buffer.alloc(32,14)});
 t.after(()=>{journal.close();fs.rmSync(dir,{recursive:true,force:true})});
 let requests=0, calls=0;
 t.mock.method(globalThis,'fetch',async()=>({ok:true,text:async()=>JSON.stringify({choices:[{message:++requests%2?{tool_calls:[{id:'call-1',type:'function',function:{name:'web_search',arguments:'{"query":"太阳系是什么？"}'}}]}:{content:'好的'}}]})}));
 const brain=new Brain({apiKey:'fixture',baseUrl:'http://fixture.invalid',model:'fixture',ownerIds:['42']});
 brain.search=async()=>{calls++;assert.equal(journal.rows[0].state,'unknown');return {success:true,text:'资料 https://example.invalid'}};
 const input={key:'private:42',userId:'42',text:'太阳系是什么？',history:[],record:false,durableToolEffects:{enabled:true,journal,batchId:'batch-1',batch:JSON.stringify([{messageId:'1',text:'太阳系是什么？'}])}};
 await brain.reply(input); await brain.reply(input);
 assert.equal(calls,1);assert.equal(journal.rows[0].state,'completed');
});


test('changed model call or batch fails closed and unknown blocks retries', async t => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'brain-effects-'));
 const journal=new EncryptedChatJournal({directory:dir,key:Buffer.alloc(32,15)});
 t.after(()=>{journal.close();fs.rmSync(dir,{recursive:true,force:true})});
 let id='one',calls=0;
 t.mock.method(globalThis,'fetch',async()=>({ok:true,text:async()=>JSON.stringify({choices:[{message:{tool_calls:[{id,type:'function',function:{name:'web_search',arguments:'{"query":"太阳系是什么？"}'}}]}}]})}));
 const brain=new Brain({apiKey:'fixture',baseUrl:'http://fixture.invalid',model:'fixture',ownerIds:[]});
 brain.search=async()=>{calls++;throw Error('uncertain')};
 const input={key:'private:42',userId:'42',text:'太阳系是什么？',record:false,trapProbe:true,durableToolEffects:{enabled:true,journal,batchId:'one',batch:'batch-one'}};
 await assert.rejects(brain.reply(input),/uncertain/);
 await assert.rejects(brain.reply(input),/blocked/);
 id='different'; await assert.rejects(brain.reply(input),/mismatch|blocked/);
 await assert.rejects(brain.reply({...input,durableToolEffects:{...input.durableToolEffects,batchId:'two'}}),/blocked/);
 assert.equal(calls,1);
});


test('handleTurn passes complete batch to real Brain tool execution', async t => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'brain-effects-'));
 const journal=new EncryptedChatJournal({directory:dir,key:Buffer.alloc(32,16)});
 t.after(()=>{journal.close();fs.rmSync(dir,{recursive:true,force:true})});
 let requests=0,calls=0;
 t.mock.method(globalThis,'fetch',async()=>({ok:true,text:async()=>JSON.stringify({choices:[{message:++requests%2?{tool_calls:[{id:'h1',type:'function',function:{name:'web_search',arguments:'{"query":"太阳系是什么？"}'}}]}:{content:'好的'}}]})}));
 const brain=new Brain({apiKey:'fixture',baseUrl:'http://fixture.invalid',model:'fixture',ownerIds:[]});
 brain.search=async()=>{calls++;return {success:true,text:'资料 https://example.invalid'}};
 const item={key:'private:42',userId:'42',name:'fixture',isGroup:false,text:'太阳系是什么？',images:[],raw:{},messageId:'1',time:1};
 const memory={dir,renderPerson:()=>'',renderRecent:()=>'',sessionTurns:()=>[],remember:()=>{},logTurn:()=>{},touch:()=>{}};
 const bot={send:async()=>({ok:true}),setTyping:async()=>{},getMyGroupCard:async()=>''};
 const human={say:async(text,{send})=>{await send(text);return {ok:true,sent:1,parts:[text]}}};
 const deps={brain,memory,bot,human,waker:{wake:()=>{}},durableToolEffects:{enabled:true,journal,batchId:'handle-1'}};
 await handleTurn(deps,[item],{ownerIds:[],dataDir:dir,dryRun:true});
 assert.equal(calls,1);assert.deepEqual(JSON.parse(journal.rows[0].args.batch),[item]);
});
