import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isForumEvidence } from '../src/tieba-playwright.js';

test('public page API proves forum and exact thread identity', () => {
  assert.equal(isForumEvidence({error_code: 0, forum:{name:'肥鱼避难所', is_exists:1}, thread:{id:123}}, '123'), true);
  assert.equal(isForumEvidence({error_code: 0, forum:{name:'肥鱼避难所', is_exists:1}, thread:{id:456}}, '123'), false);
  assert.equal(isForumEvidence({error_code: 0, forum:{name:'其他', is_exists:1}, thread:{id:123}}, '123'), false);
  assert.equal(isForumEvidence({error_code: 0, forum:{name:'肥鱼避难所', is_exists:1}}, null), true);
  assert.equal(isForumEvidence({error_code: 1, forum:{name:'肥鱼避难所', is_exists:1}}, null), false);
  assert.equal(isForumEvidence({error_code: 0, forum:{name:'肥鱼避难所', is_exists:0}}, null), false);
});
