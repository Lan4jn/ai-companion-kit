import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

test('小说和短剧未取得内容时不伪造剧情或记忆', () => {
  const source = readFileSync(new URL('../src/phone-living.js', import.meta.url), 'utf8');
  const area = source.slice(source.indexOf("case 'fanqie':"), source.indexOf('// ── 桌面：'));
  assert.ok(!area.includes('fanqieStories'));
  assert.ok(!area.includes('hongguoStories'));
  assert.ok(!area.includes('boundMemory?.logDiary'));
  assert.ok(area.includes('未获取到真实内容'));
});
