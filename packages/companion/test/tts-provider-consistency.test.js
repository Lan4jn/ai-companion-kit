import test from 'node:test';
import assert from 'node:assert/strict';
import { synthesizeChunks } from '../src/tts.js';

test('a later failure restarts every chunk with one fallback voice', async () => {
  const calls = [];
  const text = '第一句。第二句。第三句。';
  const result = await synthesizeChunks(text, { maxChunkBytes: 15 }, async (part, opts) => {
    calls.push([opts.provider, part]);
    if (opts.provider === 'fish' && calls.length === 2) return {ok:false};
    return {ok:true, base64:'YQ==', voice:`${opts.provider}:voice`};
  }, ['fish', 'edge']);
  assert.equal(result.ok, true);
  assert.deepEqual(result.chunks.map(c => c.voice), Array(result.chunks.length).fill('edge:voice'));
  assert.equal(result.chunks.map(c => c.spokenText).join(''), text);
  assert.equal(calls.filter(c => c[0] === 'fish').length, 2);
  assert.equal(calls.filter(c => c[0] === 'edge').length, result.chunks.length);
});

test('voice mismatch and exhausted providers fail closed within one pass each', async () => {
  const calls = [];
  const result = await synthesizeChunks('第一句。第二句。第三句。', {maxChunkBytes:15}, async (part, opts) => {
    calls.push(opts.provider);
    if (opts.provider === 'edge') throw new Error('unavailable');
    return {ok:true, base64:'YQ==', voice: calls.length === 1 ? 'fish:a' : 'fish:b'};
  }, ['fish', 'edge']);
  assert.equal(result.ok, false);
  assert.equal(result.chunks, undefined);
  assert.deepEqual(calls, ['fish', 'fish', 'edge']);
});

test('unknown voice identity cannot be delivered', async () => {
  const result = await synthesizeChunks('第一句。第二句。', {maxChunkBytes:15}, async () => ({ok:true, base64:'YQ=='}), ['fish']);
  assert.equal(result.ok, false);
  assert.equal(result.chunks, undefined);
});
