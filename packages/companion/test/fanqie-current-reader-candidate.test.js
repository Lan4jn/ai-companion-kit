import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectCurrentReader, selectCurrentReader} from '../src/fanqie-device-navigation.js';

test('reader candidate comes from validated catalogue and returns to same progress',async()=>{
 let back=0; const p={chapter:'第一章',page:2,total:100};
 const io={progress:async()=>p,dump:async()=>[{text:'目录',bounds:'[10,10][40,40]'}],tap:async()=>true,catalog:async()=>[{text:'星河漫游'},{text:''},{text:'作者'},{text:''},{text:'搜全文'},{text:'目录'},{text:'连载至120章'}],back:async()=>{back++}};
 assert.deepEqual(await inspectCurrentReader(io),{title:'星河漫游',description:'当前阅读器中的书；书名由目录核验，尚未提供简介。',kind:'current-reader'});assert.equal(back,1);
});

test('reader selection respects refusal and detects changed title before reading',async()=>{
 const book={title:'星河漫游',description:'当前阅读器中的书',kind:'current-reader'}; let calls=0;
 assert.deepEqual(await selectCurrentReader({inspect:async()=>book,choose:async()=>{calls++;return null}}),{ok:false,reason:'not-interested'});assert.equal(calls,1);
 let n=0;assert.deepEqual(await selectCurrentReader({inspect:async()=>++n===1?book:{...book,title:'另一部书'},choose:async()=>book}),{ok:false,reason:'screen-changed'});
 assert.deepEqual(await selectCurrentReader({inspect:async()=>book,choose:async()=>book}),{ok:true,resumed:true,bookTitle:book.title});
});

test('ambiguous catalogue and changed progress never provide a candidate',async()=>{
 let back=0;const io={progress:async()=>({chapter:'一',page:1,total:2}),dump:async()=>[{text:'目录',bounds:'[1,1][5,5]'}],tap:async()=>true,catalog:async()=>[{text:'目录'},{text:'连载至10章'}],back:async()=>{back++}};
 assert.equal(await inspectCurrentReader(io),null);assert.equal(back,0);
 let n=0;io.catalog=async()=>[{text:'书名'},{text:'作者'},{text:'搜全文'},{text:'目录'},{text:'已完结'}];io.progress=async()=>({chapter:'一',page:++n,total:2});assert.equal(await inspectCurrentReader(io),null);
});
