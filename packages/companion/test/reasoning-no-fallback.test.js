import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('正文不能回退到推理字段',()=>{const code=fs.readFileSync(new URL('../src/brain.js',import.meta.url),'utf8');assert.doesNotMatch(code,/msg(?:\?\.)?\.?content\s*\|\|\s*msg(?:\?\.)?\.?reasoning_content/)});
