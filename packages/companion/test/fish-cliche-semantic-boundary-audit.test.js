import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasFishCliche } from '../src/fish-cliche.js';

// Public synthetic examples, not real user messages. Labels describe whether
// blocking the WHOLE message as empty formulaic chatter would be justified;
// this is deliberately stricter than a substring detector.
const cases = [
  { id: 'standalone', text: '这条我认。', block: true },
  { id: 'standalone-note', text: '我记下了。', block: true },
  { id: 'standalone-catch', text: '我接住了！', block: true },
  { id: 'standalone-variant', text: '这话我记下了。', block: true },
  { id: 'allergy', text: '我记下了，青霉素过敏，急救时别用。', block: false },
  { id: 'responsibility', text: '这条我认，是我把日期记错了，我会修正。', block: false },
  { id: 'literal-catching', text: '我接住了，杯子没有摔碎。', block: false },
  { id: 'disagreement', text: '这条我认，但你说的结果并不对。', block: false },
  { id: 'qualification', text: '这条我认。报价 500 元（含税），保修三年。', block: false },
  { id: 'negation', text: '这条我认。我做错了，但你的结论不成立。', block: false },
  { id: 'quotation', text: '她说“这条我认”，是在承认错误，不是同意结论。', block: false },
  { id: 'multi-line-quote', text: '她说：“例子。\n这条我认。”这是原话。', block: false },
  { id: 'recognition', text: '这条我认同，但你的证据不能证明结论。', block: false },
  { id: 'code', text: '示例：\n```txt\n这条我认。\n```\n不要修改。', block: false },
  { id: 'actual-detail', text: '我记下了视频里的配方。', block: false },
];

test('synthetic semantic boundary audit reports blocking risks without locking in false positives', t => {
  assert.equal(new Set(cases.map(c => c.id)).size, cases.length);
  const falsePositives = [], falseNegatives = [];
  for (const item of cases) {
    const actual = hasFishCliche(item.text);
    if (actual && !item.block) falsePositives.push(item.id);
    if (!actual && item.block) falseNegatives.push(item.id);
  }
  t.diagnostic(JSON.stringify({ total: cases.length, falsePositives, falseNegatives }));
  assert.deepEqual(falsePositives, [], 'fact-bearing replies must not be blocked');
  assert.deepEqual(falseNegatives, [], 'standalone empty formulas must be detected');
  // Safety invariants independent of current detection coverage.
  for (const id of ['quotation', 'multi-line-quote', 'recognition', 'code', 'actual-detail']) {
    const item = cases.find(c => c.id === id);
    assert.equal(hasFishCliche(item.text), false, id);
  }
});
