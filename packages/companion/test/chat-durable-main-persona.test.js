import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Role} from '../src/role.js';

test('durable trusted persona uses only the explicitly trusted local card', () => {
  const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'role-durable-'));
  try {
    const card=path.join(dir,'role.md'), auto=path.join(dir,'auto.md');
    fs.writeFileSync(card,'synthetic trusted persona'); fs.writeFileSync(auto,'external injected portrait');
    const role=new Role({cardPath:card,selfImageAutoPath:auto});
    assert.throws(()=>role.buildDurablePersona(),/trust/);
    const text=role.buildDurablePersona({trustLocalCard:true});
    assert.match(text,/synthetic trusted persona/);
    assert.doesNotMatch(text,/external injected portrait/);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
