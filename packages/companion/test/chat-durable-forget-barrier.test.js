import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Memory} from '../src/memory.js';
import {startMainDurableChat} from '../src/chat-main-durable.js';
import {createAuthenticatedOneBotSender} from '../src/chat-onebot-authenticated-sender.js';

test('durable chat cannot send while history has no forget barrier', () => {
 assert.equal(startMainDurableChat({config:{enabled:false}}), null);
 const sender=createAuthenticatedOneBotSender({url:'https://localhost/',ca:Buffer.from('synthetic'),certificateSha256:'0'.repeat(64),ownerId:'123'});
 const config={enabled:true,trustLocalCard:true,ownerId:'123',directory:'/synthetic',keyPath:'/synthetic-key'};
 assert.throws(()=>startMainDurableChat({config,ownerIds:['123'],sender}), /forget barrier/);
});

test('scoped forget ledger blocks independent durable history and backfill', t => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'durable-forget-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const m=new Memory({dir});
 const turn={where:'private:123',who:'123',text:'sensitive fixture',reply:'reply fixture'};
 // Synthetic legacy-format record from the old durable writer.
 fs.mkdirSync(path.join(dir,'durable-turns'));
 fs.writeFileSync(path.join(dir,'durable-turns', 'a'.repeat(64)+'.json'),JSON.stringify({...turn,batchId:'one',t:1}));
 fs.mkdirSync(path.join(dir,'memory-brain-scoped'));
 assert.deepEqual(m.sessionTurns(turn.where),[]);
 assert.deepEqual(m.recentTurns(),[]);
 assert.deepEqual(m.recallTurns('sensitive fixture',{excludeRecent:0}),[]);
 assert.throws(()=>m.logDurableTurn('one',turn),/forget barrier/);
 assert.equal(fs.readdirSync(path.join(dir,'durable-turns')).length,1);
});
