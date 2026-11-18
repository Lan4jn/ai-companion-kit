import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatBatchQueue } from '../src/chat-batch-queue.js';

test('explicit durable queue opt-in fails closed until batching and delivery can be journaled atomically', () => {
  assert.throws(() => new ChatBatchQueue({waker:{}, run:async () => ({ok:true}), durable:true}), /durable.*unavailable/i);
});

test('ordinary in-memory queue remains the default', () => {
  const q = new ChatBatchQueue({waker:{}, run:async () => ({ok:true})});
  assert.equal(q.messageCount, 0);
});
