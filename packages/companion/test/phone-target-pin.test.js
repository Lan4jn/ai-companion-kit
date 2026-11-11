import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

test('固定设备不允许自动切换或由模型切换', () => {
 const s=readFileSync(new URL('../src/phone-tools.js',import.meta.url),'utf8');
 assert.match(s,/const PINNED_SERIAL = process\.env\.PHONE_SERIAL/);
 assert.match(s,/if \(PINNED_SERIAL\) return PINNED_SERIAL/);
 assert.match(s,/endpoint !== PINNED_SERIAL/);
 assert.match(s,/args\.use !== PINNED_SERIAL/);
});
