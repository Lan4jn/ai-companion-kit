import test from 'node:test';
import assert from 'node:assert/strict';
import * as navigation from '../src/fanqie-device-navigation.js';

test('dump with stderr failure is not fresh',()=>{
 assert.equal(navigation.isSuccessfulUiDump({stdout:'UI hierchary dumped to: /sdcard/window.xml\n',stderr:''}),true);
 assert.equal(navigation.isSuccessfulUiDump({stdout:'UI hierchary dumped to: /sdcard/window.xml\n',stderr:'ERROR: could not get idle state'}),false);
});
test('book description mentioning account security does not suppress all verified cards',()=>{
 const nodes=[{text:'书城'}, {id:'com.dragon.read:id/book_title',text:'数字迷城',bounds:'[10,100][200,130]'}, {id:'com.dragon.read:id/book_desc',text:'这是一部悬疑小说，主人公调查账号安全事件，发现城市背后隐藏着惊人的秘密。',bounds:'[10,140][400,200]'}];
 assert.equal(navigation.extractReliableCandidates(nodes)[0]?.title,'数字迷城');
});
test('foreign package cannot impersonate book card fields',()=>{
 const nodes=[{text:'书城'}, {id:'other.app:id/book_title',text:'数字迷城',bounds:'[10,100][200,130]'}, {id:'other.app:id/book_desc',text:'这是一部悬疑小说，主人公调查城市背后的秘密，发现一切并不像表面上那样简单。',bounds:'[10,140][400,200]'}];
 assert.deepEqual(navigation.extractReliableCandidates(nodes),[]);
});
test('account warning with title and description is not a book card',()=>{
 const nodes=[{text:'账号安全提示',bounds:'[10,100][200,130]'},{text:'为了您的账号安全请完成安全验证，以保护您的个人信息并防止账号被盗。',bounds:'[10,140][400,200]'}];
 assert.deepEqual(navigation.extractReliableCandidates(nodes),[]);
});
