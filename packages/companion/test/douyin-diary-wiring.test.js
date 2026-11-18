import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Memory } from '../src/memory.js';

test('legacy Douyin diary renders timestamp title and thought without undefined', () => {
  const dir=mkdtempSync(join(process.env.TMPDIR || tmpdir(),'dy-diary-'));
  try {
    writeFileSync(join(dir,'diary.jsonl'), JSON.stringify({at:'2026-11-13T10:00:00Z',category:'短视频',activity:'刷抖音',title:'测试标题',thought:'仅处理了部分画面'})+'\n');
    const result=new Memory({dir}).renderDiary();
    assert.match(result,/测试标题/); assert.match(result,/仅处理了部分画面/);
    assert.doesNotMatch(result,/Invalid Date|undefined/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('production watch requests observed replay after its metadata waits', () => {
  const source=readFileSync(new URL('../src/douyin-living.js',import.meta.url),'utf8');
  assert.match(source,/perceiveDouyinFullPage\(page,\s*activeBrain,\s*\{[^}]*restartFromBeginning:\s*true/s);
});

test('both diary paths retain separate playback and processing evidence', () => {
  const source=readFileSync(new URL('../src/douyin-living.js',import.meta.url),'utf8');
  assert.equal((source.match(/playbackComplete: .*perception\?\.playback\?\.complete === true/g)||[]).length,2);
  assert.equal((source.match(/processingComplete: .*perception\?\.complete === true/g)||[]).length,2);
});
