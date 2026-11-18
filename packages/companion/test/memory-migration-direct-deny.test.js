import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemoryBrain} from '../src/memory-brain-adapter.js';

test('direct adapter rejects migration even with caller-controlled allow callbacks', async () => {
 const brain=createMemoryBrain({enabled:true,backend:'sqlite-fts',authorize:async()=>true,recoveryAuthorization:async()=>true,migrationAuthorization:async()=>true,verifyMigrationEvidence:async()=>true});
 await assert.rejects(brain.migrateLegacyEvidence({tenant:'synthetic',platform:'qq',type:'private',session:'private:1',user:'1'},{source:'qq-private-message',evidence:'onebot-message:12'}),/migration disabled/);
});
