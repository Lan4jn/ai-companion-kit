import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// A verification challenge is not evidence that the session expired.
test('risk challenge is reported without claiming cookie expiration', () => {
  const source = fs.readFileSync(new URL('../src/douyin-living.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /cookie 已失效/);
  assert.match(source, /loginState: 'unknown'/);
});
