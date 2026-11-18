import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as navigation from '../src/fanqie-device-navigation.js';
const {verifyOpenedReader} = navigation;

test('UI dump failure must not reuse stale XML', () => {
 assert.equal(navigation.isSuccessfulUiDump('ERROR: could not get idle state.'), false);
 assert.equal(navigation.isSuccessfulUiDump('UI hierchary dumped to: /sdcard/window.xml\n'), true);
});

test('only verified selection supplies the observed title',()=>{
 const {confirmedNavigation} = navigation;
 assert.equal(typeof confirmedNavigation,'function');
 assert.deepEqual(confirmedNavigation({ok:true,title:'域河'}),{ok:true,title:'域河',bookTitle:'域河'});
 assert.deepEqual(confirmedNavigation({ok:true,resumed:true}),{ok:true,resumed:true});
 assert.deepEqual(confirmedNavigation({ok:false,title:'域河'}),{ok:false,title:'域河'});
});

test('direct reader requires exact catalog title and readable content', async () => {
 const actions=[]; const nodes=[{text:'目录',bounds:'[100,1800][200,1900]'}];
 const io={progress:async()=>({page:1,total:20}),capture:async()=>({text:'actual page'}),dump:async()=>nodes,tap:async(x,y)=>{actions.push([x,y]);return true},catalog:async()=>[{text:'域河'},{text:'目录'},{text:'连载至632章'}],back:async()=>actions.push('back')};
 assert.equal(await verifyOpenedReader({title:'域河'},io),true);
 assert.deepEqual(actions,[[150,1850],'back']);
 assert.equal(await verifyOpenedReader({title:'别的书'},io),false);
});

test('catalog permits a parenthesized edition subtitle only for a distinctive exact prefix',async()=>{
 const io={progress:async()=>({page:1,total:20}),capture:async()=>({text:'page'}),dump:async()=>[{text:'目录',bounds:'[100,1800][200,1900]'}],tap:async()=>true,catalog:async()=>[{text:'目录'},{text:'连载至558章'},{text:'待我拼好身体，旧日重临人间（旧日复苏）'}],back:async()=>{}};
 assert.equal(await verifyOpenedReader({title:'待我拼好身体，旧日重临人间'},io),true);
 assert.equal(await verifyOpenedReader({title:'待我拼好身体'},io),false);
 assert.equal(await verifyOpenedReader({title:'待我拼'},io),false);
});

test('reader evidence and catalog structure are required',async()=>{
 const io={progress:async()=>null,capture:async()=>({text:'page'}),dump:async()=>[],tap:async()=>{},catalog:async()=>[{text:'域河'}],back:async()=>{}};
 assert.equal(await verifyOpenedReader({title:'域河'},io),false);
});
