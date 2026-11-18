import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {initializeManagedStore} from '../src/memory-brain-trust.js';
import { setupProductionWeb } from '../src/index.js';

function withFakeTimers(fn) {
  const original = globalThis.setTimeout;
  const timers = [];
  globalThis.setTimeout = (callback, delay) => { timers.push({ callback, delay }); return timers.length; };
  try { return fn(timers); } finally { globalThis.setTimeout = original; }
}

test('production web scheduler honors explicit disable and dry run', t => {
  const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'web-disabled-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  initializeManagedStore(path.join(dir,'memory-brain-scoped'));
  const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'};
  const trusted={ownerIds:['1'],dataDir:dir,memoryBrain:{enabled:true,backend:'sqlite-fts',trustedProcess:true,trustedScope:scope,authorizedSources:['web-source-page']}};
  withFakeTimers(timers => {
    for (const cfg of [{ web: { enabled: false } }, { web: { enabled: true }, dryRun: true }, { dryRun: true }]) {
      setupProductionWeb({ cfg:{...trusted,...cfg}, brain: {}, memory: {dir} });
      assert.equal(timers.length, 0);
    }
  });
});

test('production web scheduler preserves default and explicit enable for a trusted owner', t => {
  const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'web-schedule-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  initializeManagedStore(path.join(dir,'memory-brain-scoped'));
  const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'};
  const trusted={ownerIds:['1'],dataDir:dir,memoryBrain:{enabled:true,backend:'sqlite-fts',trustedProcess:true,trustedScope:scope,authorizedSources:['web-source-page']}};
  for (const cfg of [{}, { web: {} }, { web: { enabled: true } }]) {
    withFakeTimers(timers => {
      setupProductionWeb({ cfg:{...trusted,...cfg}, brain: {}, memory: {dir} });
      assert.equal(timers.length, 2);
      assert.ok(timers.some(timer => timer.delay === 20000));
    });
  }
});

test('scheduler fails closed without a trusted single owner', () => {
  withFakeTimers(timers => { setupProductionWeb({cfg:{},brain:{},memory:{}}); assert.equal(timers.length,0); });
});
