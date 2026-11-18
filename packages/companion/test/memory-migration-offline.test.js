import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemoryManager} from '../src/memory-brain-management.js';

test('migration is disabled without an audit sink and management authorization', async () => {
 const input={context:{tenant:'synthetic',platform:'qq',type:'private',session:'private:1',user:'1'},source:'qq-private-message',evidence:'onebot-message:12'};
 const manager=createMemoryManager({enabled:true,backend:'sqlite-fts'});
 await assert.rejects(manager.migrateLegacyEvidence(input),/management access denied/);
});

test('migration audit failure prevents access to memory and is content-free', async () => {
 let authCalls=0; const seen=[];
 const manager=createMemoryManager({enabled:true,backend:'sqlite-fts',authorizeManagement:async()=>true,migrationAuthorization:async()=>{authCalls++;return true},verifyMigrationEvidence:async()=>true,migrationAudit:async entry=>{seen.push(entry);throw Error('unavailable')}});
 await assert.rejects(manager.migrateLegacyEvidence({context:{tenant:'synthetic',platform:'qq',type:'private',session:'private:1',user:'1'},source:'qq-private-message',evidence:'onebot-message:12'}),/audit unavailable/);
 assert.equal(authCalls,0); assert.deepEqual(seen,[{operation:'migrateLegacyEvidence',phase:'attempt'}]);
});
