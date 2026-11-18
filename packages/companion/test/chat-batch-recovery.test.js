import test from 'node:test';
import assert from 'node:assert/strict';
import { Waker } from '../src/wake.js';
import { ChatBatchQueue } from '../src/chat-batch-queue.js';

const addBatch = (q, session, sender, prefix) => {
  for (let i = 0; i < 6; i++) q.add(`${session}:${sender}`, { key: session, userId: sender, text: `${prefix}${i}` }, 60000);
};

test('explicit confirmation of prior delivery resumes held turns in session order', async () => {
  const calls = [];
  const q = new ChatBatchQueue({waker: new Waker(), run: async items => {
    calls.push(items[0].text);
    return {ok: items[0].text !== 'a0'};
  }});
  addBatch(q, 'g', 'a', 'a'); addBatch(q, 'g', 'b', 'b');
  await assert.rejects(q.drain());
  addBatch(q, 'g', 'c', 'c'); addBatch(q, 'h', 'd', 'd');
  await assert.rejects(q.drain());
  assert.deepEqual(calls, ['a0', 'd0']);
  assert.equal(await q.resolveFailure('g', 'delivered'), true);
  await q.drain();
  assert.deepEqual(calls, ['a0', 'd0', 'b0', 'c0']);
  assert.equal(q.undelivered.length, 0);
  q.stop();
});

test('verified not delivered batch can be retried explicitly before later turns', async () => {
  const calls = []; let first = true;
  const q = new ChatBatchQueue({waker:new Waker(), run:async items => {
    calls.push(items[0].text);
    if (first) { first = false; return {ok:false}; }
    return {ok:true};
  }});
  addBatch(q, 'g', 'a', 'a'); addBatch(q, 'g', 'b', 'b');
  await assert.rejects(q.drain());
  assert.throws(() => q.resolveFailure('g', 'not-delivered'), /reconciliation/);
  assert.equal(await q.resolveFailure('g', 'safe-to-retry'), true);
  await q.drain();
  assert.deepEqual(calls, ['a0', 'a0', 'b0']);
  q.stop();
});

test('concurrent confirmations cannot resolve a later failure without verifying it', async () => {
  const calls = [];
  const q = new ChatBatchQueue({waker:new Waker(), run:async items => {
    calls.push(items[0].text);
    return {ok:false};
  }});
  addBatch(q, 'g', 'a', 'a'); addBatch(q, 'g', 'b', 'b'); addBatch(q, 'g', 'c', 'c');
  await assert.rejects(q.drain());
  const first = q.resolveFailure('g', 'delivered');
  const duplicate = q.resolveFailure('g', 'delivered');
  assert.equal(await first, true);
  assert.equal(await duplicate, false);
  await assert.rejects(q.drain());
  assert.deepEqual(calls, ['a0', 'b0']);
  assert.deepEqual(q.undelivered.map(b => b[0].text), ['b0', 'c0']);
  q.stop();
});
