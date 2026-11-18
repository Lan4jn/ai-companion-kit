import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as integration from '../src/hongguo-integration.js';
const matchesSelectedHongguo = (...args) => integration.matchesSelectedHongguo?.(...args);
test('selected identity tolerates punctuation width and spacing but not another title',()=>{
 assert.equal(matchesSelectedHongguo('全球死考：刚下刑场你让我去考试一季','全球死考: 刚下刑场你让我去考试一季:第2集'),true);
 assert.equal(matchesSelectedHongguo('全球死考：刚下刑场你让我去考试二季','全球死考: 刚下刑场你让我去考试一季:第2集'),false);
 assert.equal(matchesSelectedHongguo('短剧','短剧:第2集'),false);
});
