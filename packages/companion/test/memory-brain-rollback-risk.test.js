import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, cpSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createMemoryBrain} from '../src/memory-brain-adapter.js';

test('full memory-directory rollback must not resurrect a revoked source', {todo:'requires independent anti-rollback authority; currently vulnerable'}, async t => {
 const root = mkdtempSync(join(tmpdir(), 'memory-rollback-'));
 t.after(() => rmSync(root, {recursive:true, force:true}));
 const dir = join(root, 'live'); const backup = join(root, 'snapshot');
 mkdirSync(dir, {mode:0o700});
 const options = {enabled:true, directory:dir, authorize:()=>true};
 const context = {tenant:'t',platform:'p',type:'private',session:'s',user:'u'};
 const brain = createMemoryBrain(options);
 await brain.remember(context, {text:'synthetic apple',source:'chat',evidence:'synthetic-1'});
 cpSync(dir, backup, {recursive:true});
 await brain.revoke(context, {source:'chat'});
 await assert.rejects(brain.recall(context, {query:'apple',sources:['chat']}));
 rmSync(dir, {recursive:true});
 cpSync(backup, dir, {recursive:true});
 const restored = createMemoryBrain(options);
 await assert.rejects(restored.recall(context, {query:'apple',sources:['chat']}));
});
