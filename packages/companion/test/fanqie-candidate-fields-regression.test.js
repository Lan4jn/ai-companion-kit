import {test} from 'node:test';
import assert from 'node:assert/strict';
import {extractReliableCandidates} from '../src/fanqie-device-navigation.js';

test('only title fields may be titles and only description fields may be descriptions',()=>{
 const title='一'.repeat(30), description='这是一段足够长的小说简介，讲述主人公寻找真相并解开城市隐藏秘密的故事。';
 const node=(id,text,bounds)=>({id:`com.dragon.read:id/${id}`,text,bounds});
 const cards=[{text:'书城'},node('book_title',title,'[10,100][200,130]'),node('book_desc',description,'[10,140][400,200]')];
 const result=extractReliableCandidates(cards);
 assert.equal(result.length,1); assert.equal(result[0].title,title); assert.equal(result[0].description,description);
 assert.deepEqual(extractReliableCandidates([{text:'书城'},node('book_desc',title,'[10,100][200,130]'),node('book_desc',description,'[10,140][400,200]')]),[]);
 assert.deepEqual(extractReliableCandidates([{text:'书城'},node('book_title','小说名字','[10,100][200,130]'),node('book_title',description,'[10,140][400,200]')]),[]);
});
