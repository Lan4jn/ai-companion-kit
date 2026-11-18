import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {loadConfig} from '../src/index.js';

test('application accepts explicit AME and rejects unknown backends', () => {
 const dir=mkdtempSync(join(tmpdir(),'ame-config-'));
 try {
  const file=join(dir,'config.json');
  writeFileSync(file,JSON.stringify({memoryBrain:{enabled:true,backend:'ame'}}));
  assert.equal(loadConfig(file).memoryBrain.backend,'ame');
  writeFileSync(file,JSON.stringify({memoryBrain:{enabled:true,backend:'typo'}}));
  assert.throws(()=>loadConfig(file),/invalid application memory backend/);
  writeFileSync(file,JSON.stringify({memoryBrain:{enabled:true}}));
  assert.equal(loadConfig(file).memoryBrain.backend,undefined);
  writeFileSync(file,JSON.stringify({memoryBrain:{enabled:false,backend:'ame'}}));
  assert.equal(loadConfig(file).memoryBrain.backend,'ame');
 } finally {rmSync(dir,{recursive:true,force:true});}
});
