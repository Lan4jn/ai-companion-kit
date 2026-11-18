import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareConciseReply } from '../src/chat-concise-delivery.js';

const code = '```js\na()\n\nb()\n```';

test('three compliant paragraphs preserve fenced code without rewriting', async () => {
  const draft = `${code}\n\n说明一。\n\n说明二。`;
  let calls = 0;
  const result = await prepareConciseReply(draft, async () => { calls++; });
  assert.equal(calls, 0);
  assert.deepEqual(result.parts, [draft]);
});

test('required rewrite keeps internal fenced blank lines and is reviewed', async () => {
  const draft = `${code}\n\n说明一。\n\n说明二。\n\n说明三。`;
  const candidate = `${code}\n说明一。\n\n说明二。\n\n说明三。`;
  let calls = 0, reviews = 0;
  const result = await prepareConciseReply(draft, async () => { calls++; return candidate; }, async (original, rewritten) => {
    reviews++; assert.equal(original, draft); assert.equal(rewritten, candidate); return true;
  });
  assert.equal(calls, 1); assert.equal(reviews, 1);
  assert.equal(result.failed, undefined);
  assert.deepEqual(result.parts, [`${code}\n说明一。`, '说明二。', '说明三。']);
});

test('regrouped rewrite cannot bypass semantic review', async () => {
  const draft = '第一点。\n\n第二点。\n\n第三点。\n\n第四点。';
  let reviews = 0;
  const result = await prepareConciseReply(draft, async () => '第一点。\n第二点。\n\n第三点。\n\n第四点。', async () => { reviews++; return false; });
  assert.equal(reviews, 5); assert.equal(result.failed, true);
});
