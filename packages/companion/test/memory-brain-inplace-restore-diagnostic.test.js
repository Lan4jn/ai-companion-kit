import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, cpSync, readdirSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {initializeMemoryBrainSession} from '../src/memory-brain-session-candidate.js';

test('diagnostic: in-place restore defeats directory identity even during a session', async t => {
 const root = mkdtempSync(join(tmpdir(), 'memory-inplace-'));
 t.after(() => rmSync(root, {recursive:true, force:true}));
 const dir = join(root, 'live'), backup = join(root, 'backup');
 const scope = {tenant:'t', platform:'qq', type:'private', session:'private:1', user:'1'};
 const session = initializeMemoryBrainSession({directory:dir, scope, sources:['chat'], continuity:()=>true});
 t.after(() => session.close());
 await session.memory.remember(scope, {text:'synthetic apple', source:'chat', evidence:'synthetic-1'});
 cpSync(dir, backup, {recursive:true});
 await session.memory.revoke(scope, {source:'chat'});
 // Restore the *contents* without changing the directory inode.
 for (const name of readdirSync(dir)) rmSync(join(dir, name), {recursive:true, force:true});
 cpSync(backup, dir, {recursive:true});
 assert.equal((await session.memory.recall(scope, {query:'apple', sources:['chat']})).length, 1);
});
