import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createMemoryBrain} from '../src/memory-brain-adapter.js';

test('untrusted migration callbacks cannot enable the legacy adapter path', async t => {
 const directory = fs.mkdtempSync(path.join(process.env.TMPDIR, 'migration-denied-'));
 t.after(() => fs.rmSync(directory, {recursive:true, force:true}));
 let calls = 0;
 const callback = async () => { calls++; return true; };
 const store = createMemoryBrain({enabled:true, backend:'sqlite-fts', directory, retentionMs:86400000,
  authorize:callback, recoveryAuthorization:callback, migrationAuthorization:callback, verifyMigrationEvidence:callback});
 const scope = {tenant:'synthetic', platform:'qq', type:'private', session:'private:1', user:'1'};
 await assert.rejects(store.migrateLegacyEvidence(scope, {source:'qq-private-message', evidence:'onebot-message:12'}), /migration disabled/);
 assert.equal(calls, 0);
 assert.deepEqual(fs.readdirSync(directory), []);
});

test('manual offline migration executes against isolated synthetic data', () => {
 const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
 execFileSync('/usr/bin/python3', ['-m', 'unittest',
  'memory_offline_migrate_test.Offline.test_positive_and_duplicate',
  'memory_offline_migrate_test.Offline.test_bad_proof_and_scope',
  'memory_offline_migrate_test.Offline.test_forget_and_audit_failure_fail_closed'],
  {cwd:path.join(root, 'test'), env:process.env, timeout:30000, stdio:'pipe'});
});
