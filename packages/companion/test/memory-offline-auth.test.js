import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

test('offline migration requires a terminal, never accepts piped confirmation', () => {
 const directory=fs.mkdtempSync(path.join(process.env.TMPDIR,'offline-auth-'));
 try {
  const p=spawnSync('/usr/bin/python3',['scripts/memory-offline-migrate.py',directory],{input:'CONFIRM\n',encoding:'utf8'});
  assert.notEqual(p.status,0); assert.match(p.stderr,/terminal required/);
  assert.deepEqual(fs.readdirSync(directory),[]);
 } finally { fs.rmSync(directory,{recursive:true,force:true}); }
});
