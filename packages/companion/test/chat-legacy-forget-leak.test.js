import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Memory} from '../src/memory.js';

// The legacy log has no stable turn ID; it must not resurrect private evidence
// once the scoped forget ledger is active.
test('legacy private turns cannot bypass active scoped forget ledger', t => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'legacy-forget-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const memory=new Memory({dir});
 memory.logTurn({where:'private:123',who:'123',text:'synthetic forgotten text',reply:'synthetic reply'});
 fs.mkdirSync(path.join(dir,'memory-brain-scoped'));
 assert.deepEqual(memory.sessionTurns('private:123'), []);
 assert.deepEqual(memory.recentTurns(), []);
 assert.deepEqual(memory.recallTurns('synthetic forgotten',{excludeRecent:0}), []);
});
