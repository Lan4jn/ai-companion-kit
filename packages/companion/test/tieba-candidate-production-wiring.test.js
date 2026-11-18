import test from 'node:test';
import assert from 'node:assert/strict';
import { setupProductionTieba } from '../src/index.js';

test('candidate opt-in fails closed without a trusted in-process capability', () => {
  let made = 0;
  assert.throws(() => setupProductionTieba({ cfg:{tieba:{enabled:true,authenticatedCandidate:true}}, makeSource:()=>{made++;return {};} }), /tieba_candidate_unavailable/);
  assert.equal(made,0);
});

test('candidate reader and room provider share one capability and shutdown closes it', async () => {
  const source = { list:async()=>[], read:async()=>({}) };
  const provider = { start:async()=>({state:'unknown'}), status:async()=>({state:'unknown'}) };
  let closeCount=0, reader, stopped=0;
  const candidate = { source, provider, close:async()=>{closeCount++;} };
  const h=setupProductionTieba({cfg:{dataDir:process.env.TMPDIR,tieba:{enabled:true,authenticatedCandidate:true}}, brain:{complete:async()=>''}, candidate, makeSource:()=>{throw Error('anonymous fallback forbidden');}, makeScheduler:options=>{reader=options.reader;return {start(){},stop:async()=>{stopped++;}};}});
  assert.equal(h.loginProvider,provider);
  assert.equal((await reader.run()).status,'no_posts');
  await h.stop();
  assert.equal(stopped,1);assert.equal(closeCount,1);
});
