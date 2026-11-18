import test from 'node:test';
import assert from 'node:assert/strict';
import {Brain} from '../src/brain.js';
import {createAuthenticatedOneBotSender} from '../src/chat-onebot-authenticated-sender.js';
import {createAuthenticatedOneBotQueueCandidate} from '../src/chat-onebot-queue-bridge.js';
import {EncryptedChatJournal} from '../src/chat-durable-journal-candidate.js';
import {DurableBatchCandidate} from '../src/chat-durable-batch-candidate.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';

test('durable brain generation fails closed without explicit local card trust', () => {
 const sender=createAuthenticatedOneBotSender({url:'https://localhost/',ca:Buffer.from('fixture'),certificateSha256:'a'.repeat(64),ownerId:'123'});
 const brain=new Brain({apiKey:'fixture',ownerIds:['123']});
 const dir=mkdtempSync(join(process.env.TMPDIR,'durable-context-'));
 const journal=new EncryptedChatJournal({directory:dir,key:Buffer.alloc(32,8)});
 try {
  const queue=new DurableBatchCandidate(journal);
  assert.throws(()=>createAuthenticatedOneBotQueueCandidate({enabled:true,queue,bot:{},sender,sealKey:Buffer.alloc(32,9),selectorKey:Buffer.alloc(32,10),ownerId:'123',brain,brainGenerationEnabled:true}),/trusted local brain and card required/);
 } finally {journal.close();rmSync(dir,{recursive:true,force:true});}
});
