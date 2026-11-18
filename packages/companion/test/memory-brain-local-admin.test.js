import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
test('local admin rejects non-interactive callers before performing any operation',()=>{
 const p=spawnSync(process.execPath,['scripts/memory-brain-admin.mjs'],{input:'anything\n',encoding:'utf8'});
 assert.notEqual(p.status,0);
 assert.match(p.stderr,/interactive terminal required/);
});
